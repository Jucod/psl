import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // A single shared database: no parallelism across files.
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
