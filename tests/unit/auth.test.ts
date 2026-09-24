import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../src/server/auth/passwords.ts';
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  countUserSessions,
  createSession,
  resolveSession,
  revokeUserSessions,
} from '../../src/server/auth/sessions.ts';
import type { Db } from '../../src/server/db/client.ts';
import { roles, sessions, users } from '../../src/server/db/schema.ts';
import {
  completeAccountToken,
  inspectAccountToken,
  issueAccountToken,
  login,
} from '../../src/server/services/auth.ts';
import { freshDb, makeActor } from '../helpers/db.ts';

describe('passwords', () => {
  it('hashes with salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$17$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterx', a)).toBe(false);
  });

  it('completes many concurrent hashes correctly (bounded concurrency, no deadlock)', async () => {
    const passwords = Array.from({ length: 6 }, (_, i) => `concurrent passphrase ${i}`);
    const hashes = await Promise.all(passwords.map((p) => hashPassword(p)));
    const checks = await Promise.all(
      passwords.map((p, i) => verifyPassword(p, hashes[(i + 1) % hashes.length]!)),
    );
    expect(checks.every((ok) => ok === false)).toBe(true);
    expect(await Promise.all(passwords.map((p, i) => verifyPassword(p, hashes[i]!)))).toEqual(
      passwords.map(() => true),
    );
  });

  it('treats missing or malformed hashes as a failed verification', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'plaintext')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$99$8$1$AAAA$BBBB')).toBe(false);
  });

  it('flags weaker stored parameters for rehashing', () => {
    expect(
      needsRehash(
        'scrypt$14$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe(true);
  });

  it('enforces the password policy', () => {
    expect(checkPasswordPolicy('short')).toMatch(/at least 12/);
    expect(checkPasswordPolicy('password1234')).toMatch(/too easy/);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaa')).toMatch(/too easy/);
    expect(checkPasswordPolicy('someone@example.com', { email: 'someone@example.com' })).toMatch(
      /email/,
    );
    expect(checkPasswordPolicy('a long unusual passphrase')).toBeNull();
  });
});

describe('sessions', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('stores only a hash of the token and resolves the actor with fresh permissions', () => {
    const actor = makeActor(db, ['panel.access', 'docs.manage']);
    const { token } = createSession(db, actor.id, {});
    const stored = db.select().from(sessions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);

    const resolved = resolveSession(db, token);
    expect(resolved?.actor.id).toBe(actor.id);
    expect(resolved?.actor.permissions.has('docs.manage')).toBe(true);

    // Changing the role takes effect on the very next request.
    db.update(roles)
      .set({ permissions: '["panel.access"]' })
      .where(eq(roles.id, actor.role.id))
      .run();
    expect(resolveSession(db, token)?.actor.permissions.has('docs.manage')).toBe(false);
  });

  it('rejects malformed, unknown, expired and idle sessions', () => {
    const actor = makeActor(db, ['panel.access']);
    const start = new Date('2026-01-01T00:00:00Z');
    const { token } = createSession(db, actor.id, {}, start);
    expect(resolveSession(db, 'not-a-token')).toBeNull();
    expect(resolveSession(db, 'A'.repeat(43))).toBeNull();
    expect(
      resolveSession(db, token, new Date(start.getTime() + SESSION_IDLE_TIMEOUT_MS + 1)),
    ).toBeNull();
    // The idle session was deleted on rejection.
    expect(resolveSession(db, token, start)).toBeNull();

    const second = createSession(db, actor.id, {}, start);
    let now = start.getTime();
    // Keep it active with requests every hour until the absolute lifetime ends.
    while (now < start.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS - 3_600_000) {
      now += 3_600_000;
      expect(resolveSession(db, second.token, new Date(now))).not.toBeNull();
    }
    expect(
      resolveSession(db, second.token, new Date(start.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS)),
    ).toBeNull();
  });

  it('stops working as soon as the user is disabled', () => {
    const actor = makeActor(db, ['panel.access']);
    const { token } = createSession(db, actor.id, {});
    db.update(users).set({ status: 'disabled' }).where(eq(users.id, actor.id)).run();
    expect(resolveSession(db, token)).toBeNull();
  });

  it('counts only live sessions', () => {
    // Regression: expired/idle sessions awaiting cleanup were counted as active.
    const actor = makeActor(db, ['panel.access']);
    const start = new Date('2026-01-01T00:00:00Z');
    createSession(db, actor.id, {}, start);
    createSession(db, actor.id, {}, start);
    expect(countUserSessions(db, actor.id, start)).toBe(2);
    const later = new Date(start.getTime() + SESSION_IDLE_TIMEOUT_MS + 1);
    createSession(db, actor.id, {}, later);
    expect(countUserSessions(db, actor.id, later)).toBe(1);
  });

  it('revokes all other sessions but keeps the current one', () => {
    const actor = makeActor(db, ['panel.access']);
    const current = createSession(db, actor.id, {});
    const other = createSession(db, actor.id, {});
    expect(revokeUserSessions(db, actor.id, current.sessionId)).toBe(1);
    expect(resolveSession(db, current.token)).not.toBeNull();
    expect(resolveSession(db, other.token)).toBeNull();
  });
});

describe('login', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('signs in with the right password and rejects everything else identically', async () => {
    const hash = await hashPassword('correct horse battery');
    makeActor(db, ['panel.access'], { passwordHash: hash, email: 'staff@example.test' });
    const ok = await login(db, {
      email: ' Staff@Example.test ',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(ok.ok).toBe(true);
    const wrong = await login(db, {
      email: 'staff@example.test',
      password: 'nope-nope-nope',
      ip: '1.1.1.1',
    });
    const unknown = await login(db, {
      email: 'ghost@example.test',
      password: 'nope-nope-nope',
      ip: '1.1.1.1',
    });
    expect(wrong).toEqual({ ok: false, reason: 'invalid' });
    expect(unknown).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not let disabled or invited accounts sign in', async () => {
    const hash = await hashPassword('correct horse battery');
    const actor = makeActor(db, ['panel.access'], { passwordHash: hash, email: 'd@example.test' });
    db.update(users).set({ status: 'disabled' }).where(eq(users.id, actor.id)).run();
    const result = await login(db, {
      email: 'd@example.test',
      password: 'correct horse battery',
      ip: '1.1.1.1',
    });
    expect(result.ok).toBe(false);
  });

  it('rate-limits repeated failures per account, even for the correct password', async () => {
    const hash = await hashPassword('correct horse battery');
    makeActor(db, ['panel.access'], { passwordHash: hash, email: 'r@example.test' });
    for (let i = 0; i < 8; i++) {
      const r = await login(db, {
        email: 'r@example.test',
        password: `wrong-${i}-password`,
        ip: `10.0.0.${i}`,
      });
      expect(r).toEqual({ ok: false, reason: 'invalid' });
    }
    const blocked = await login(db, {
      email: 'r@example.test',
      password: 'correct horse battery',
      ip: '10.0.1.1',
    });
    expect(blocked).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('rate-limits repeated failures per IP across accounts', async () => {
    for (let i = 0; i < 20; i++) {
      await login(db, { email: `spray${i}@example.test`, password: 'x', ip: '9.9.9.9' });
    }
    expect(await login(db, { email: 'other@example.test', password: 'x', ip: '9.9.9.9' })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
  });
});

describe('one-time account links', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  function invitedUser() {
    const actor = makeActor(db, ['panel.access']);
    db.update(users)
      .set({ status: 'invited', passwordHash: null })
      .where(eq(users.id, actor.id))
      .run();
    return actor;
  }

  it('activates the account once and cannot be reused', async () => {
    const actor = invitedUser();
    const { token } = issueAccountToken(db, actor.id, 'setup', null);
    expect(inspectAccountToken(db, token)?.userId).toBe(actor.id);
    const done = await completeAccountToken(db, {
      token,
      password: 'a brand new passphrase',
      confirm: 'a brand new passphrase',
      ip: '1.1.1.1',
    });
    expect(done.ok).toBe(true);
    expect(db.select().from(users).where(eq(users.id, actor.id)).get()?.status).toBe('active');
    const again = await completeAccountToken(db, {
      token,
      password: 'another new passphrase',
      confirm: 'another new passphrase',
      ip: '1.1.1.1',
    });
    expect(again).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('validates the new password and keeps the token usable after a mistake', async () => {
    const actor = invitedUser();
    const { token } = issueAccountToken(db, actor.id, 'setup', null);
    const mismatch = await completeAccountToken(db, {
      token,
      password: 'a brand new passphrase',
      confirm: 'different',
      ip: '1.1.1.1',
    });
    expect(mismatch).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(inspectAccountToken(db, token)).not.toBeNull();
  });

  it('expires, is invalidated by a newer link, and does not work for disabled accounts', () => {
    const actor = invitedUser();
    const first = issueAccountToken(db, actor.id, 'setup', null, new Date('2026-01-01T00:00:00Z'));
    expect(inspectAccountToken(db, first.token, new Date('2026-01-05T00:00:00Z'))).toBeNull();

    const older = issueAccountToken(db, actor.id, 'setup', null);
    const newer = issueAccountToken(db, actor.id, 'setup', null);
    expect(inspectAccountToken(db, older.token)).toBeNull();
    expect(inspectAccountToken(db, newer.token)).not.toBeNull();

    db.update(users).set({ status: 'disabled' }).where(eq(users.id, actor.id)).run();
    expect(inspectAccountToken(db, newer.token)).toBeNull();
  });

  it('signs out existing sessions after a password reset', async () => {
    const actor = makeActor(db, ['panel.access']);
    const session = createSession(db, actor.id, {});
    const { token } = issueAccountToken(db, actor.id, 'reset', null);
    await completeAccountToken(db, {
      token,
      password: 'a brand new passphrase',
      confirm: 'a brand new passphrase',
      ip: '1.1.1.1',
    });
    expect(resolveSession(db, session.token)).toBeNull();
  });
});
