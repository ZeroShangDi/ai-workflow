import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['node_modules', 'sandbox'],
    globals: false,
    // T1-098：run 会话内跑套件时清掉外层 CC_*/AWF_* env，保证 hermitic（见 setup-env-scrub.js）
    setupFiles: ['./tests/setup-env-scrub.js'],
    coverage: {
      provider: 'v8',
      include: ['cli/**/*.{js,cjs}', 'server/**/*.{js,cjs}', 'plugin/core/**/*.{js,cjs}'],
      exclude: ['cli/awf.cjs'],
      reportsDirectory: 'coverage',
    },
  },
});
