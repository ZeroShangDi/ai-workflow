import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['node_modules', 'sandbox'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,cjs}', 'plugin/core/**/*.{js,cjs}'],
      exclude: ['src/awf.js'],
      reportsDirectory: 'coverage',
    },
  },
});
