import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 120000,
  use: { baseURL: 'http://127.0.0.1:4178/chinese-translate/', headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
  webServer: { command: 'node tests/serve.mjs', url: 'http://127.0.0.1:4178/chinese-translate/', reuseExistingServer: false },
});
