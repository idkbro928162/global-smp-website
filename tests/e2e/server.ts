/**
 * TEST ONLY. Prepares a throwaway data directory containing the demo content
 * and an owner account with a known test password, then runs the production
 * build against it. Never point this at a real data directory.
 *
 * Usage (via playwright.config.ts): node tests/e2e/server.ts <port>
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const E2E_OWNER = { email: 'owner@example.test', password: 'e2e owner passphrase' };

const port = process.argv[2] ?? '4610';
const root = path.resolve(import.meta.dirname, '../..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'bp-e2e-'));
const env = { ...process.env, DATA_DIR: dataDir, SITE_URL: `http://127.0.0.1:${port}` };
Object.assign(process.env, env);

const seed = spawnSync(process.execPath, ['scripts/seed-demo.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (seed.status !== 0) throw new Error('Demo seed failed');

const { getDb, setDatabaseForTests } = await import('../../src/server/db/client.ts');
const { createOwnerInvite } = await import('../../src/server/services/staff-accounts.ts');
const { completeAccountToken } = await import('../../src/server/services/auth.ts');
const db = getDb();
const owner = createOwnerInvite(db, { email: E2E_OWNER.email, displayName: 'E2E Owner' });
if (!owner.ok) throw new Error('Could not create the e2e owner');
const activated = await completeAccountToken(db, {
  token: owner.value.link.token,
  password: E2E_OWNER.password,
  confirm: E2E_OWNER.password,
  ip: '127.0.0.1',
});
if (!activated.ok) throw new Error('Could not activate the e2e owner');
setDatabaseForTests(undefined);

const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  cwd: root,
  env: { ...env, HOST: '127.0.0.1', PORT: port },
  stdio: 'inherit',
});

const cleanup = () => {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
server.on('exit', (code) => {
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
