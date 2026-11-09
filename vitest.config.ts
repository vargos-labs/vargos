import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    // Nested checkouts duplicate suites and collide on fixed test ports.
    exclude: [...configDefaults.exclude, '.claude/**', 'dist/**'],
  },
});
