import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression test for the `import.meta.url === \`file://${process.argv[1]}\``
// guard that used to gate main() in src/mcp/index.ts. That comparison put a
// percent-encoded URL against a raw filesystem path, so any install path
// containing a space (or `#`, or non-ASCII characters) — e.g. the README's
// own `node /absolute/path/to/webharvest/dist/mcp/index.js`, run from
// somewhere like `~/My Projects/webharvest` — made the comparison false.
// The server would then start, connect no transport, and exit 0: silent,
// unannounced failure, exactly what this project exists to prevent.
//
// This drives the real built binary (dist/mcp/index.js) as a child process
// from a path that contains a space, feeding it a real initialize +
// tools/list JSON-RPC sequence over stdio and asserting a real response
// comes back. Against the pre-fix comparison this produces no response at
// all (the process exits 0 having never connected a transport), which is
// exactly the failure mode a unit test on the predicate alone would not
// catch end-to-end.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let entryWithSpace: string;
let entryPlain: string;
let tmpRoot: string;

beforeAll(() => {
  // Rebuild so dist reflects the current state of src/mcp/index.ts exactly
  // (this also makes the mutation check in the report meaningful: reverting
  // the source fix and re-running `npm test` rebuilds the old, broken dist).
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });

  // Resolve tmpdir() to its real path first: on macOS it lives under /var,
  // itself a symlink to /private/var, and Node realpaths import.meta.url
  // through that symlink but not process.argv[1]. Starting from the real
  // path isolates the test to the one variable it's meant to exercise (a
  // space in the path) instead of an unrelated platform symlink hop.
  tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), 'webharvest test '));
  cpSync(join(repoRoot, 'dist'), join(tmpRoot, 'dist'), { recursive: true });
  // dist/mcp/index.js needs the real dependency tree to resolve
  // '@modelcontextprotocol/sdk/...' — symlink node_modules in at the temp
  // root so Node's normal upward node_modules search finds it. This is a
  // symlink on a *directory two levels above* the entry file, not on the
  // entry file itself, so it does not touch import.meta.url resolution for
  // the script under test.
  symlinkSync(join(repoRoot, 'node_modules'), join(tmpRoot, 'node_modules'), 'dir');

  entryWithSpace = join(tmpRoot, 'dist', 'mcp', 'index.js');
  entryPlain = join(repoRoot, 'dist', 'mcp', 'index.js');
}, 30_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: { tools?: { name: string }[] };
  error?: unknown;
}

function initializeAndListToolsSequence(): string {
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'spawn-test', version: '0.0.0' } } };
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  return [initialize, initialized, listTools].map((m) => JSON.stringify(m)).join('\n') + '\n';
}

async function spawnAndCollect(entry: string): Promise<JsonRpcResponse[]> {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, WEBHARVEST_URL: 'http://127.0.0.1:1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    lines.push(...parts.filter((l) => l.length > 0));
  });

  child.stdin.write(initializeAndListToolsSequence());

  const responses = await new Promise<JsonRpcResponse[]>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(lines.map((l) => JSON.parse(l) as JsonRpcResponse));
    }, 3_000);
    // Resolve early once we have a response to the tools/list request (id 2).
    const check = (): void => {
      if (lines.some((l) => { try { return (JSON.parse(l) as JsonRpcResponse).id === 2; } catch { return false; } })) {
        clearTimeout(timer);
        child.kill();
        resolve(lines.map((l) => JSON.parse(l) as JsonRpcResponse));
      }
    };
    child.stdout.on('data', check);
  });

  return responses;
}

describe('dist/mcp/index.js spawned as the real binary', () => {
  it('отвечает на initialize + tools/list, будучи запущенным из пути с пробелом', async () => {
    const responses = await spawnAndCollect(entryWithSpace);
    const toolsList = responses.find((r) => r.id === 2);
    expect(toolsList).toBeDefined();
    expect(toolsList?.result?.tools?.map((t) => t.name).sort()).toEqual([
      'browser_click',
      'browser_close',
      'browser_fill',
      'browser_hover',
      'browser_open',
      'browser_press',
      'browser_scroll',
      'browser_select',
      'browser_snapshot',
      'browser_type',
      'scrape',
      'search',
    ]);
  }, 10_000);

  it('отвечает на initialize + tools/list, будучи запущенным из обычного пути (контроль)', async () => {
    const responses = await spawnAndCollect(entryPlain);
    const toolsList = responses.find((r) => r.id === 2);
    expect(toolsList).toBeDefined();
    expect(toolsList?.result?.tools?.map((t) => t.name).sort()).toEqual([
      'browser_click',
      'browser_close',
      'browser_fill',
      'browser_hover',
      'browser_open',
      'browser_press',
      'browser_scroll',
      'browser_select',
      'browser_snapshot',
      'browser_type',
      'scrape',
      'search',
    ]);
  }, 10_000);
});
