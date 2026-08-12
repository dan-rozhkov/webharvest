# webharvest

A local Firecrawl alternative: scrape and search over MCP. Query search engines, fetch and parse web pages, all via Claude's MCP protocol.

## What It Does

**webharvest** is a daemon that:
- Runs a local [Model Context Protocol](https://modelcontextprotocol.io/) server
- Exposes search (via SearXNG) and web scraping (via Playwright)
- Integrates with Claude Code as an MCP server
- Enforces politeness: per-domain request queueing (2 concurrent, 500 ms apart)
- Caches results in SQLite for 24 hours by default

You control the browser automation — no opaque API calls, no subscription, all on your machine.

## Installation

### Prerequisites

- **Node 20+**
- **Docker & Docker Compose** (for SearXNG search)
- **Chromium** (installed via Playwright, see below)

### Steps

1. **Clone and build:**
   ```bash
   git clone <repo-url>
   cd webharvest
   npm install
   npx playwright install chromium
   npm run build
   ```

2. **Install the CLI globally:**
   ```bash
   npm link
   ```
   This makes `webharvest` available as a command in your shell. Alternatively, use `npx webharvest` to run without installing globally.

3. **Start SearXNG (search backend):**
   ```bash
   # Create your local config from the template (one-time).
   # searxng/settings.yml is gitignored: secret_key is per-install and must not be committed.
   cp searxng/settings.yml.example searxng/settings.yml
   sed -i '' "s/CHANGE_ME_TO_A_RANDOM_STRING/$(openssl rand -hex 32)/" searxng/settings.yml
   
   # Start the container
   docker compose up -d
   
   # Verify it's up (wait 10 seconds, then):
   curl -s 'http://127.0.0.1:8080/search?q=hello&format=json' | head -c 100
   ```
   The last command must return JSON. If it returns HTML or a 403, `formats` in
   `searxng/settings.yml` is missing `json` — fix it and restart the container.
   Note that `limiter` must stay `false`, or SearXNG rate-limits the daemon querying it.

4. **Register the daemon with launchd (macOS only for now):**
   ```bash
   webharvest install
   ```
   This registers the daemon with launchd, so it starts automatically and restarts if it crashes. Use `webharvest start` to start it immediately, or it will start at next login.

5. **Connect to Claude Code:**
   ```bash
   claude mcp add webharvest -- node /absolute/path/to/webharvest/dist/mcp/index.js
   ```
   Replace the path with the actual path to your clone. You can find it with `pwd` in the webharvest directory.

### Automated Setup (hand this prompt to an AI agent)

If you'd rather not run the steps above by hand, paste the prompt below into an
agent that can execute shell commands and edit files (Claude Code, Codex,
Cursor, Gemini CLI, …). It performs the same installation and then registers
webharvest as an MCP server in whichever agents you have installed.

Read it before you run it: it installs a launchd job, starts a Docker
container, and edits your agents' MCP config files.

````text
You are setting up "webharvest" — a local MCP server that gives you web search
and web scraping. Work through the steps in order, run every verification
command, and stop and report if one fails instead of continuing.

Repository: the directory you were pointed at, or clone it if I gave you a URL.
Let REPO be its absolute path (get it with `pwd`, never guess, never use `~`).

1. Prerequisites. Check `node --version` (must be 20+), `docker --version`, and
   `docker compose version`. If Docker is not installed or its daemon is not
   running, tell me and stop — search will not work without it.

2. Build.
     cd REPO && npm install && npx playwright install chromium && npm run build
   Verify REPO/dist/mcp/index.js, REPO/dist/cli/index.js and
   REPO/dist/daemon/index.js now exist.

3. Search backend (SearXNG). If REPO/searxng/settings.yml does not exist:
     cp searxng/settings.yml.example searxng/settings.yml
   then replace the literal CHANGE_ME_TO_A_RANDOM_STRING in it with the output
   of `openssl rand -hex 32`. Never commit this file — it is gitignored on
   purpose. In that file confirm `formats` contains `json` and `limiter` is
   `false`; fix them if not. Then:
     docker compose up -d
   Wait ~10 s and verify search actually answers with JSON:
     curl -s 'http://127.0.0.1:8080/search?q=hello&format=json' | head -c 100
   HTML or a 403 back means the settings above are wrong. Fix and restart the
   container; do not move on.

4. Daemon. Run `npm link` in REPO so the `webharvest` command exists (if that
   needs sudo on this machine, tell me instead of running sudo yourself).
   On macOS: `webharvest install` — this already loads the launchd job and
   starts the daemon, so run `webharvest status` next and only call
   `webharvest start` if it reports the daemon is not running.
   On Linux/Windows there is no launchd integration — start the daemon in the
   background yourself with `node REPO/dist/daemon/index.js` and tell me it
   will not survive a reboot.
   Verify: `curl -s http://127.0.0.1:8787/health` returns JSON.

5. Register as an MCP server. The MCP entry point is always:
     command: node
     args:    ["REPO/dist/mcp/index.js"]
   It talks to the daemon over http://127.0.0.1:8787 and does not start it, so
   step 4 must be working first. If the daemon runs on another port, also set
   the env var WEBHARVEST_URL for the server.

   Do this for each agent that is actually installed on this machine — check
   with `command -v claude`, `command -v codex`, … and not by the existence of
   a ~/.something directory, which is often left behind by an uninstall. Skip
   the rest, and never overwrite an existing "webharvest" entry without
   telling me:

   - Claude Code:
       claude mcp add -s user webharvest -- node REPO/dist/mcp/index.js
     `-s user` matters: without it the server is registered only for the
     directory you happen to be in.
   - Codex: add to ~/.codex/config.toml
       [mcp_servers.webharvest]
       command = "node"
       args = ["REPO/dist/mcp/index.js"]
   - Cursor (~/.cursor/mcp.json), Windsurf, Claude Desktop, and most others
     use the same JSON shape — merge into the existing "mcpServers" object,
     do not replace the file:
       { "mcpServers": { "webharvest": {
           "command": "node", "args": ["REPO/dist/mcp/index.js"] } } }
   - Gemini CLI: same JSON shape in ~/.gemini/settings.json.

   If an agent you find is not in this list, look up its MCP config location in
   its own docs and use the same command/args.

6. Verify end to end. Talk to the MCP server directly over stdio, so you do
   not have to restart anything to know it works:
     printf '%s\n' \
       '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
       '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
       '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"model context protocol","limit":3}}}' \
       | node REPO/dist/mcp/index.js 2>/dev/null | tail -1
   That must come back with real search results, not "Не удалось" — the latter
   means the daemon or SearXNG is not reachable, so go back to step 3 or 4.
   Then repeat with a `scrape` call on one of the returned URLs.
   Also confirm the registration itself: `claude mcp list` for Claude Code
   (expect "webharvest … ✔ Connected"), `codex mcp list` for Codex. For the
   others, tell me to restart the agent and check that the tools `scrape` and
   `search` appear.

7. Report: what you installed, the exact paths and config files you touched,
   what still needs a restart, and anything you skipped and why.
````

### Common Commands

- `webharvest start` — Start the daemon manually
- `webharvest stop` — Stop the daemon
- `webharvest status` — Check if it's running
- `webharvest logs` — Follow daemon logs (Ctrl+C to exit)
- `webharvest uninstall` — Remove launchd registration

## What It Can't Do

**webharvest** has clear limitations. Before opening an issue, check this list:

### ❌ No PDF Support

PDFs are not parsed. The scraper detects the non-HTML content type and returns a clean `not_html` error — it never hands you raw binary data. Use a dedicated PDF parser if you need full-text extraction from PDFs.

### ❌ No Authentication

Pages that require login are not supported. The scraper has no credential storage, session management, or form-filling logic for authentication. If a page redirects to a login screen, the scraper will return the login page HTML, not the authenticated content.

### ⚠️ Interactive Anti-Bot Challenges — partially solved

Challenges like Cloudflare Turnstile are handled **best-effort**, not guaranteed:

- **Real Chrome**: with `browserChannel: "chrome"` the scraper drives your system
  Google Chrome instead of bundled chromium — it passes Cloudflare's
  bot checks far more often. If Chrome is not installed, webharvest falls
  back to bundled chromium automatically.
- **Persistent profile**: with `browserProfileDir` set, the browser keeps a
  persistent profile, so cookies (including Cloudflare's `cf_clearance`)
  survive daemon restarts. The first visit to a protected site warms the
  clearance; subsequent visits go straight through.
- **Challenge handling**: when a Cloudflare/Turnstile challenge appears, the
  scraper waits for it to auto-resolve (most Turnstile checks pass without
  any input) and, after ~4s, clicks the Turnstile checkbox once as a
  best-effort nudge for interactive mode.

Example: `https://www.bazaraki.com` (behind Cloudflare Turnstile) returns its
real content via the browser with `browserChannel: "chrome"`.

What is **not** solved:

- Interactive hCaptcha/DataDome challenges and any challenge requiring manual
  input (image selection, etc.)
- Blocking based on IP reputation — rotating proxies are out of scope

If a challenge cannot be resolved, the response reports status `blocked` with
an explanation. There is no integration with captcha-solving services.

### ❌ robots.txt Is Not Enforced as a Prohibition

The scraper does **not** read or honour `robots.txt` as a legal prohibition. Instead, politeness is enforced through rate limiting:
- **Per-domain request queue**: at most 2 concurrent requests per domain, 500 ms apart
- **This is respectful by default**: delays stack, so successive requests to the same domain are naturally throttled

The brief specifies why `robots.txt` as a prohibition was deliberately omitted: it is a machine-readable convention, not a legal boundary, and enforcing it in code would create false confidence. Rate limiting is more honest: you are making fewer, slower requests, which is measurably less disruptive than hitting a site at full speed.

A `respectRobots` config flag was considered and removed. It is not coming back. Rate limiting is the mechanism.

### ❌ SSRF Protection Doesn't Close DNS Rebinding

The private-address check (`assertPublicHost`) resolves the hostname and validates the addresses it gets, but that's a check-then-use, not a closed gate: undici and Playwright each resolve the hostname again, independently, when they actually connect. A host with a short DNS TTL that answers with a public address during the check and a private one moments later (classic DNS rebinding) can walk past the guard. Properly closing this needs pinned-IP dispatch — resolve once, force every subsequent connection onto that exact address, and validate the connecting socket's remote address before reading any bytes — which is real engineering, not a quick patch, and is out of scope for a personal tool. Known and accepted, not silently assumed away.

## Configuration

Settings live in `~/.webharvest/config.json`. The daemon only ever reads this
file — it is never created for you, so if you want to override defaults,
create it yourself:

```json
{
  "port": 8787,
  "cachePath": "/Users/you/.webharvest/cache.db",
  "cacheTtlMs": 86400000,
  "searxngUrl": "http://127.0.0.1:8080",
  "braveApiKey": null,
  "idleTimeoutMs": 300000
}
```

Note: `cachePath` is used as-is, with no `~` expansion — write an absolute
path (as above), not `~/.webharvest/cache.db`, or you'll get a literal `./~`
directory relative to wherever the daemon happens to be started from.

Environment variables override config file settings:
- `WEBHARVEST_PORT` — daemon listening port
- `WEBHARVEST_SEARXNG_URL` — search backend URL
- `BRAVE_API_KEY` — optional Brave Search API key (for fallback search)
- `WEBHARVEST_BROWSER_CHANNEL` — `"chromium"` (default) | `"chrome"` — use your
  system Google Chrome instead of the bundled chromium. Real Chrome passes
  Cloudflare/Turnstile checks much more often. If Chrome is not installed, the
  daemon automatically falls back to bundled chromium.
- `WEBHARVEST_BROWSER_PROFILE_DIR` — path to a persistent browser profile.
  Cookies (including Cloudflare's `cf_clearance`) survive daemon restarts,
  so protected sites are only "warmed up" once. Disabled by default. Note:
  the profile is shared between scrape and browser-use via two subdirectories
  (`<dir>/scrape` and `<dir>/sessions`) — two Chromium processes cannot share
  one `userDataDir`, hence the split.

The same keys can be set in `~/.webharvest/config.json` as `browserChannel`
and `browserProfileDir`.

Note: `host` and `allowPrivate` cannot be set from config.json for security reasons. The daemon always binds to `127.0.0.1` only.

There is no LLM configuration, and no LLM API key is ever needed. The daemon
doesn't run its own model — browser-use is a set of deterministic tools
(`browser_open`, `browser_snapshot`, `browser_click`, `browser_fill`, …) that
directly manipulate the page; the reasoning about *what* to do with the page
is left entirely to whichever agent is calling webharvest (e.g. Claude Code),
which already sees the page tree in its own context.

## Browser Use Tools

Beyond `scrape` and `search`, webharvest exposes a small set of deterministic
browser-automation tools over MCP. There is no inference step in the daemon:
every tool call does exactly the one thing it's named for, and returns a
diff of what changed on the page (or the fresh page tree itself) so the
calling agent can decide the next step.

- `browser_open(url)` — opens a page in a real (headless) browser, returns a
  `sessionId` and the page's accessibility tree. The page stays open between
  calls.
- `browser_snapshot(sessionId)` — returns a fresh tree of the same page,
  without performing any action.
- `browser_click(sessionId, elementId)`
- `browser_hover(sessionId, elementId)`
- `browser_fill(sessionId, elementId, text, variables?)` — clears the field
  and types `text` into it.
- `browser_type(sessionId, elementId, text, variables?)` — types `text`
  character by character (real keydown events), for fields that need it
  (autocompletes, input masks).
- `browser_press(sessionId, elementId, key)`
- `browser_select(sessionId, elementId, value)` — picks an option in a
  native `<select>` by its label.
- `browser_scroll(sessionId, elementId, percent)`
- `browser_close(sessionId)`

`elementId` is a `frame-node` address (e.g. `0-18372`) copied verbatim from
the tree returned by the last `browser_open`/`browser_snapshot` call, or from
the diff returned by the previous action — addresses can change after every
action, so always use the freshest one.

`browser_fill`/`browser_type` still support the same `variables` +
`%name%`-placeholder mechanism as before. Its purpose changed along with the
architecture: it used to keep secrets out of the daemon's own model call;
now, with no model inside the daemon, it keeps secrets out of the calling
agent's own context instead — write `%password%` in `text`, pass the real
value as `variables: { password: "..." }`, and the daemon substitutes it
right before typing into the browser. The value never has to appear in the
agent's conversation history to be used. The substituted value is still
redacted back out of the page tree the daemon returns (see
`redactSecrets`/`registerSecrets` in `src/core/a11y/format.ts` and
`src/daemon/service.ts`), so it doesn't leak back to the agent through a
later snapshot either.

## Architecture

- **src/core/** — Scraping logic: browser pool, SSRF protection, cache
- **src/daemon/** — HTTP server (localhost only) with health check
- **src/mcp/** — Model Context Protocol server (stdio-based)
- **src/cli/** — Command-line interface for daemon management
- **searxng/** — Docker Compose config and SearXNG settings

## Development

```bash
npm test          # Run unit tests
npm run typecheck # TypeScript strict mode check
npm run build     # Compile to dist/
```

Tests are excluded from the live-test suite unless you run `npm run test:live`.

## License

[Check LICENSE file]

## Attribution

webharvest переиспользует код из [Stagehand](https://github.com/browserbase/stagehand)
(MIT, © Browserbase, Inc.) — слой представления accessibility-дерева и контракт
промптов act/observe/extract. Подробности в [NOTICE](./NOTICE).
