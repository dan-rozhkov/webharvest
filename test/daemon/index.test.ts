import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';

// Genuine process-level integration test: src/daemon/index.ts is a script
// with side effects at import time (registers signal handlers, calls
// app.listen()), so the only honest way to test its SIGTERM/SIGINT handling
// and its EADDRINUSE path is to actually run it as a separate process and
// send it real signals — importing it in-process would install handlers and
// bind a port inside the test runner itself.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const viteNodeBin = resolve(repoRoot, 'node_modules/.bin/vite-node');

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

function spawnDaemon(port: number): ChildProcessWithoutNullStreams {
  const fakeHome = mkdtempSync(join(tmpdir(), 'webharvest-daemon-home-'));
  return spawn(viteNodeBin, ['src/daemon/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: fakeHome,
      WEBHARVEST_PORT: String(port),
      // Unreachable on purpose: startup must not depend on a real search
      // backend, and this keeps the test from touching the network.
      WEBHARVEST_SEARXNG_URL: 'http://127.0.0.1:1/',
    },
  });
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon on port ${port} never became healthy: ${String(lastErr)}`);
}

let children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
});

describe('daemon entry point', () => {
  it('SIGTERM закрывает HTTP и завершает процесс с кодом 0 (не по дефолтному сигналу ОС)', async () => {
    const port = randomPort();
    const child = spawnDaemon(port);
    children.push(child);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    await waitForHealth(port);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      child.once('exit', (code, signal) => res({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exited;

    // If the SIGTERM handler in index.ts were removed, Node's default
    // reaction to an unhandled SIGTERM is immediate termination with
    // signal 'SIGTERM' and code null, and it would never print the
    // shutdown line below — that's exactly what this pins against.
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(stdout).toContain('получен SIGTERM');

    // The port is actually free again — proof the HTTP server (not just
    // the process) really stopped, not that it's hung and got killed by
    // the OS default action.
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toBeTruthy();
  }, 20_000);

  it('SIGINT завершает процесс тем же путём остановки', async () => {
    const port = randomPort();
    const child = spawnDaemon(port);
    children.push(child);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });

    await waitForHealth(port);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      child.once('exit', (code, signal) => res({ code, signal }));
    });
    child.kill('SIGINT');
    const { code, signal } = await exited;

    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(stdout).toContain('получен SIGINT');
  }, 20_000);

  it('EADDRINUSE не роняет процесс необработанным исключением', async () => {
    const port = randomPort();
    const first = spawnDaemon(port);
    children.push(first);
    await waitForHealth(port);

    const second = spawnDaemon(port);
    children.push(second);
    let stderr = '';
    second.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
      second.once('exit', (code, signal) => res({ code, signal }));
    });
    const { code } = await exited;

    // Without the try/catch around app.listen(), a bind failure becomes an
    // unhandled promise rejection: Node prints a raw stack trace and the
    // process exits with a Node-internal code, not our own clear message.
    expect(code).not.toBe(0);
    expect(stderr).toContain('не удалось запуститься');
    expect(stderr).not.toMatch(/at .*:\d+:\d+/); // no raw V8 stack frame lines
  }, 20_000);
});
