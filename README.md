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
   Verify REPO/dist/mcp/index.js and REPO/dist/cli/index.js now exist.

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
   On macOS: `webharvest install` then `webharvest start`.
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
   first, skip the rest, and never overwrite an existing "webharvest" entry
   without telling me:

   - Claude Code:  claude mcp add webharvest -- node REPO/dist/mcp/index.js
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

6. Verify end to end. For Claude Code run `claude mcp list` and confirm
   webharvest is connected. For the others, tell me to restart the agent and
   check that the tools `scrape` and `search` appear. If you yourself can reach
   the new server, call `search` with the query "model context protocol" and
   `scrape` on the first result URL, and show me the output.

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

### ❌ Interactive Anti-Bot Challenges

Challenges like Cloudflare Turnstile, hCaptcha, or DataDome are **not solved**. These are reported with status `blocked` and an explanation in the response. There is no integration with captcha-solving services.

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

Note: `host` and `allowPrivate` cannot be set from config.json for security reasons. The daemon always binds to `127.0.0.1` only.

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
