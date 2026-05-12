import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.MAILERY_E2E_PORT ?? 5174)
const BASE = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false, // shared in-memory state → serialize
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Build the SPA + start the harness server before tests run.
  webServer: {
    // mongodb-memory-server can take ~30s on first run to download mongod.
    command: 'yarn build:client && yarn tsx test/e2e/server.ts',
    url: `${BASE}/__test__/ready`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
