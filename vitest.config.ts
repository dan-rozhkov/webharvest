import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Note: exclude is in the npm test script flag only (--exclude 'test/live/**'),
    // not here in config. Adding it to config would block `npm run test:live` from
    // finding test/live files, since vitest's exclude applies universally and
    // blocks the positional path argument from overriding it.
    testTimeout: 20_000,
  },
});
