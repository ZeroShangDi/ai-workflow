import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['node_modules', 'sandbox'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,cjs}'],
      exclude: ['src/awf.js', 'src/mcp/mcp.json.template'],
      reportsDirectory: 'coverage',
    },
  },
});
