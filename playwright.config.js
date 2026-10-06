import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  workers: 1,
  use: { baseURL: process.env.AUTO_RESET_TEST_URL || 'http://127.0.0.1:4780', headless: true },
  reporter: 'list',
});
