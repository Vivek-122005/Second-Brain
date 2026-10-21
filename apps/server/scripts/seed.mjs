// Imports the sample vault (fixtures/vault) into a running server through the REST API.
//
//   SECOND_BRAIN_KEY=sb_live_... pnpm --filter @second-brain/server seed
//   SECOND_BRAIN_API_URL defaults to http://localhost:8787
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const api = process.env.SECOND_BRAIN_API_URL ?? 'http://localhost:8787';
const key = process.env.SECOND_BRAIN_KEY;
if (!key) {
  console.error(
    'Set SECOND_BRAIN_KEY to an API key (create one in the web app under Keys & Devices).',
  );
  process.exit(1);
}

const root = new URL('../../../fixtures/vault/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.md'))
      files.push({ path: relative(root, full), content: readFileSync(full, 'utf8') });
  }
})(root);

const res = await fetch(`${api}/api/v1/import`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ files, message: 'Seed sample vault' }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`Import failed (${res.status}):`, body.detail ?? body);
  process.exit(1);
}
console.warn(
  `Imported ${body.imported} notes (${body.skipped.length} skipped) as ${body.commit_sha}.`,
);
