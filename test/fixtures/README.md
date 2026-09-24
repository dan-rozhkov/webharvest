# Test fixtures: what these files are and where they come from

The HTML files here are **snapshots of public web pages**, committed as test
input. They are not content served or redistributed by webharvest — they exist
so that the extractor (`src/core/extractor.ts`) and the escalation thresholds
(`src/core/escalation.ts`) can be tested offline, deterministically, and without
making a request to somebody else's site on every `npm test`.

Rights to the text and markup in each snapshot stay with the people who wrote
it. If you hold rights to one of these pages and would rather not have the
snapshot here, open an issue and it will be removed.

| fixture | source | terms |
| --- | --- | --- |
| `mdn-fetch.html` | <https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch> | MDN prose CC BY-SA 2.5, code samples CC0 |
| `wikipedia-web.html` | <https://en.wikipedia.org/wiki/World_Wide_Web> | Wikipedia contributors, CC BY-SA 4.0 (<https://creativecommons.org/licenses/by-sa/4.0/>) — attribution: the linked article and its history page |
| `vitest-docs.html` | <https://vitest.dev/guide/> | MIT (vitest-dev/vitest) |
| `playwright-docs.html` | <https://playwright.dev/docs/intro> | Apache-2.0 (microsoft/playwright) |
| `hn-front.html` | <https://news.ycombinator.com/> | link titles submitted by users, Y Combinator site terms |
| `github-repo.html` | <https://github.com/microsoft/playwright> | repository content Apache-2.0; page chrome under GitHub's terms |
| `nodejs-blog.html` | <https://nodejs.org/en/blog/release/v22.0.0> | MIT (nodejs/nodejs.org) |
| `substack-post.html` | <https://astralcodexten.substack.com/archive> | © the author, Substack terms |
| `spa-shell.html` | written for these tests | — |
| `cf-challenge.html` | written for these tests | — |

All snapshots were taken on 2026-08-09 from public pages, with no logged-in
session and no personal data involved. `manifest.json` maps each fixture id to
the URL it came from plus what the test expects of it.

## Do not "tidy" these files

Two reasons, both practical:

- The escalation thresholds are **calibrated on these exact bytes**: the
  script-to-text ratios quoted in `src/core/escalation.ts` (github-repo 7.94,
  nodejs-blog 9.40, substack-post 125.68) were measured on these snapshots.
  Editing a fixture silently invalidates the reasoning behind the constants.
- The bulk is load-bearing. `github-repo` and `nodejs-blog` are in the test
  table as pages that must **not** be mistaken for an SPA shell (heavy JS, real
  server-rendered text); strip their scripts and that expectation stops proving
  anything. Same for the navigation junk (`Skip to main content`, `Sign up`, …)
  — it is the input the extractor is supposed to strip, so trimming the
  snapshot to just the article makes those assertions pass by construction.

If a fixture genuinely needs to change, re-measure the thresholds and update the
comments in `src/core/escalation.ts` in the same commit.
