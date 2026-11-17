import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror wrangler's Text rule so modules importing .sql files work under test.
  plugins: [
    {
      name: 'sql-as-text',
      transform(code, id) {
        if (id.endsWith('.sql')) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    // Each integration beforeEach boots workerd and replays every migration
    // statement; the first one per file regularly exceeds vitest's 10s default
    // when several files start in parallel.
    hookTimeout: 60000,
    setupFiles: [],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/api-collections/**'],
  },
});
