/**
 * Starts the production build (dist/server/entry.mjs) against a temporary
 * data directory with a fixed set of staff accounts, created through the same
 * service functions the app and CLI use. Run `npm run build` first
 * (`npm run test:integration` does this for you).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

export const PASSWORD = 'integration test passphrase';

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
    password: string;
    setupToken: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(),
      );
    });
  });
}

export default async function setup(project: TestProject) {
  const root = path.resolve(import.meta.dirname, '../..');
  const entry = path.join(root, 'dist/server/entry.mjs');
  if (!existsSync(entry)) throw new Error('dist/ is missing: run `npm run build` first.');

  const dataDir = mkdtempSync(path.join(tmpdir(), 'bp-integration-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.DATA_DIR = dataDir;
  process.env.SITE_URL = baseUrl;

  const { getDb, setDatabaseForTests } = await import('../../src/server/db/client.ts');
  const { createSession, resolveSession } = await import('../../src/server/auth/sessions.ts');
  const { completeAccountToken, issueAccountToken } =
    await import('../../src/server/services/auth.ts');
  const { createOwnerInvite, inviteStaff, setStaffDisabled } =
    await import('../../src/server/services/staff-accounts.ts');
  const { createRole } = await import('../../src/server/services/roles.ts');
  const { eq } = await import('drizzle-orm');
  const { roles } = await import('../../src/server/db/schema.ts');

  const db = getDb();
  const activate = async (token: string) => {
    const result = await completeAccountToken(db, {
      token,
      password: PASSWORD,
      confirm: PASSWORD,
      ip: '127.0.0.1',
    });
    if (!result.ok) throw new Error(`Could not activate test account: ${JSON.stringify(result)}`);
  };

  const owner = createOwnerInvite(db, { email: 'owner@example.test', displayName: 'Owner' });
  if (!owner.ok) throw new Error('owner');
  await activate(owner.value.link.token);
  const ownerActor = resolveSession(db, createSession(db, owner.value.userId, {}).token)!.actor;
  const ctx = { actor: ownerActor, ip: '127.0.0.1' };

  const roleId = (name: string) => db.select().from(roles).where(eq(roles.name, name)).get()!.id;
  const noPanel = createRole(db, ctx, {
    name: 'No panel',
    description: '',
    permissions: ['docs.manage'],
  });
  const staffOnly = createRole(db, ctx, {
    name: 'Staff manager',
    description: '',
    permissions: ['panel.access', 'staff.manage'],
  });
  if (!noPanel.ok || !staffOnly.ok) throw new Error('roles');

  const invite = async (email: string, role: number) => {
    const result = inviteStaff(db, ctx, { email, displayName: email.split('@')[0], roleId: role });
    if (!result.ok) throw new Error(`invite ${email}: ${JSON.stringify(result.errors)}`);
    await activate(result.value.link.token);
    return result.value.userId;
  };
  await invite('admin@example.test', roleId('Administrator'));
  await invite('editor@example.test', roleId('Editor'));
  await invite('writer@example.test', roleId('Documentation writer'));
  await invite('nopanel@example.test', noPanel.value.id);
  await invite('staffmanager@example.test', staffOnly.value.id);
  // Used only by the rate-limit test, which locks the account for 15 minutes.
  await invite('ratelimited@example.test', roleId('Documentation writer'));
  const disabledId = await invite('disabled@example.test', roleId('Editor'));
  setStaffDisabled(db, ctx, disabledId, true);

  const pending = inviteStaff(db, ctx, {
    email: 'pending@example.test',
    displayName: 'Pending',
    roleId: roleId('Editor'),
  });
  if (!pending.ok) throw new Error('pending');
  const setupToken = issueAccountToken(db, pending.value.userId, 'setup', ownerActor.id).token;
  setDatabaseForTests(undefined);

  const server: ChildProcess = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      SITE_URL: baseUrl,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      // Lets tests give each file its own client IP (and exercises the proxy path).
      TRUST_PROXY: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout?.on('data', (chunk) => (output += chunk));
  server.stderr?.on('data', (chunk) => (output += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/robots.txt`);
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  project.provide('baseUrl', baseUrl);
  project.provide('password', PASSWORD);
  project.provide('setupToken', setupToken);

  return () => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
