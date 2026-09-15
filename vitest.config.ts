import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'tests/parity/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    environment: 'node',
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
  },
})
