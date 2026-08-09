import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `test/live/**` is intentionally NOT excluded here. On vitest 2.1.x a
    // config-level `exclude` suppresses even an explicitly-named positional
    // path, so adding it here would make `npm run test:live` report "No test
    // files found". Instead:
    //   - `npm test` passes `--exclude 'test/live/**'` on the CLI (see package.json).
    //   - Every test in test/live/** self-skips unless WEBHARVEST_LIVE=1 is set,
    //     so a bare `npx vitest run` collects those files but skips them (visibly,
    //     as skips) instead of hitting the network.
    //   - `npm run test:live` sets WEBHARVEST_LIVE=1 so they actually run.
    testTimeout: 20_000,
  },
});
