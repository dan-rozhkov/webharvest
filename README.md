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

2. **Start SearXNG (search backend):**
   ```bash
   # Generate a random secret for SearXNG (one-time)
   sed -i '' "s/CHANGE_ME_TO_A_RANDOM_STRING/$(openssl rand -hex 16)/" searxng/settings.yml
   
   # Start the container
   docker compose up -d
   
   # Verify it's up (wait 10 seconds, then):
   curl -s 'http://127.0.0.1:8080/search?q=hello&format=json' | head -c 100
   ```

3. **Install the daemon (macOS only for now):**
   ```bash
   webharvest install
   ```
   This registers the daemon with launchd, so it starts automatically and restarts if it crashes.

4. **Connect to Claude Code:**
   ```bash
   claude mcp add webharvest -- node /path/to/webharvest/dist/mcp/index.js
   ```

### Common Commands

- `webharvest start` — Start the daemon manually
- `webharvest stop` — Stop the daemon
- `webharvest status` — Check if it's running
- `webharvest logs` — Follow daemon logs (Ctrl+C to exit)
- `webharvest uninstall` — Remove launchd registration

## What It Can't Do

**webharvest** has clear limitations. Before opening an issue, check this list:

### ❌ No PDF Support

PDFs are fetched but not parsed. The scraper returns raw binary data and exits. Use a dedicated PDF parser if you need full-text extraction from PDFs.

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

## Configuration

Settings live in `~/.webharvest/config.json` (created on first run):

```json
{
  "port": 8787,
  "cachePath": "~/.webharvest/cache.db",
  "cacheTtlMs": 86400000,
  "searxngUrl": "http://127.0.0.1:8080",
  "braveApiKey": null,
  "idleTimeoutMs": 300000
}
```

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
