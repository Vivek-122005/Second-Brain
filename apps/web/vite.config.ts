import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// The Worker serves `dist/` as static assets in production (single origin, so the session cookie
// just works). In development the app runs against the in-memory mock API by default
// (`.env.development`). With VITE_MOCK_API=false, API, MCP and OAuth paths are proxied to the
// local Worker (`wrangler dev` on :8787) so the app still talks to a single origin.
const WORKER_ORIGIN = 'http://localhost:8787';
const PROXIED_PATHS = ['/api', '/mcp', '/oauth', '/.well-known'];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const mock = env.VITE_MOCK_API === 'true';
  const target = env.VITE_DEV_PROXY_TARGET || WORKER_ORIGIN;

  return {
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      sourcemap: true,
      chunkSizeWarningLimit: 700,
    },
    server: {
      port: 5173,
      proxy: mock
        ? undefined
        : Object.fromEntries(PROXIED_PATHS.map((p) => [p, { target, changeOrigin: false }])),
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
    },
  };
});
