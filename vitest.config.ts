import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/cli is exercised end-to-end via spawned `node dist/cli/index.js`
      // subprocesses, which v8 cannot instrument; it is intentionally excluded
      // from coverage rather than silently under-measured.
      exclude: ['src/cli/**'],
      thresholds: {
        // §43: deterministic core logic held to ~full coverage.
        'src/core/**': { lines: 90, statements: 90, functions: 85, branches: 78 },
      },
    },
  },
});
