/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `"true"` switches the app to the in-memory mock API. */
  readonly VITE_MOCK_API?: string;
  /** API origin; empty means same origin (the Worker serves both). */
  readonly VITE_API_URL?: string;
  /** Dev server only: where /api, /mcp, /oauth and /.well-known are proxied (default :8787). */
  readonly VITE_DEV_PROXY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
