// Wrangler requires the static-assets folder to exist. The web app (apps/web) builds into it;
// before the first web build, create it empty so the API and MCP server can still run.
import { mkdirSync } from 'node:fs';

mkdirSync(new URL('../../web/dist', import.meta.url), { recursive: true });
