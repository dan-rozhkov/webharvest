import { writeFile, mkdir } from 'node:fs/promises';
import { request } from 'undici';

const TARGETS = [
  { id: 'mdn-fetch',     url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch' },
  { id: 'wikipedia-web', url: 'https://en.wikipedia.org/wiki/World_Wide_Web' },
  { id: 'nodejs-blog',   url: 'https://nodejs.org/en/blog/release/v22.0.0' },
  { id: 'vitest-docs',   url: 'https://vitest.dev/guide/' },
  { id: 'playwright-docs', url: 'https://playwright.dev/docs/intro' },
  { id: 'hn-front',      url: 'https://news.ycombinator.com/' },
  { id: 'github-repo',   url: 'https://github.com/microsoft/playwright' },
  { id: 'substack-post', url: 'https://astralcodexten.substack.com/archive' },
];

await mkdir(new URL('../test/fixtures/', import.meta.url), { recursive: true });

for (const t of TARGETS) {
  try {
    const res = await request(t.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36' },
      maxRedirections: 5,
      connect: { timeout: 30000 },
    });
    const html = await res.body.text();
    const path = new URL(`../test/fixtures/${t.id}.html`, import.meta.url);
    await writeFile(path, html, 'utf8');
    console.log(`${t.id}: ${res.statusCode}, ${html.length} bytes`);
  } catch (err) {
    console.error(`${t.id}: ERROR - ${err.code || err.message}`);
  }
}
