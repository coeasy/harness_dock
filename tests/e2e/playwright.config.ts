import { defineConfig } from '@playwright/test'

// Electron smoke tests. Electron launches are deliberately serialized
// (workers: 1, retries: 0): each app boots its own mock dsh + user data dir,
// and parallel instances would race on resources / single-instance lock state.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
})
