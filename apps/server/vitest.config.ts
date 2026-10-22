import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(`${import.meta.dirname}/../../packages/db/migrations`);
  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        miniflare: {
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: {
            ENVIRONMENT: 'test',
            SIGNUP_MODE: 'allowlist',
            ALLOWED_EMAILS: 'owner@example.com,second@example.com',
            APP_ORIGINS: 'http://app.test',
            EMAIL_FROM: 'test@example.com',
            KEY_PEPPER: 'test-pepper',
            RATE_LIMITS: 'off',
            // base64("0123456789abcdef0123456789abcdef"): a fixed 32-byte test-only KEK.
            VAULT_KEK: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
