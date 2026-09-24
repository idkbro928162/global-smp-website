/**
 * Test helpers: an isolated in-memory database and actors with specific
 * permissions, created through the same code paths the app uses.
 */
import { eq } from 'drizzle-orm';
import { effectivePermissions, type Actor } from '../../src/server/auth/authorization.ts';
import { ALL_PERMISSIONS, type Permission } from '../../src/server/auth/permissions.ts';
import { openDatabase, setDatabaseForTests, nowIso, type Db } from '../../src/server/db/client.ts';
import { roles, users } from '../../src/server/db/schema.ts';

export function freshDb(): Db {
  const handle = openDatabase(':memory:');
  setDatabaseForTests(handle);
  return handle.db;
}

let counter = 0;

/** Creates an active user with a new role holding exactly `permissions`, and returns its Actor. */
export function makeActor(
  db: Db,
  permissions: readonly Permission[] | 'owner',
  options: { passwordHash?: string; email?: string } = {},
): Actor {
  counter += 1;
  const at = nowIso();
  const isOwner = permissions === 'owner';
  const role = isOwner
    ? db.select().from(roles).where(eq(roles.isOwner, true)).get()!
    : db
        .insert(roles)
        .values({
          name: `Test role ${counter}`,
          permissions: JSON.stringify(permissions),
          isOwner: false,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
  const email = options.email ?? `user${counter}@example.test`;
  const user = db
    .insert(users)
    .values({
      email,
      displayName: `User ${counter}`,
      passwordHash:
        options.passwordHash ??
        'scrypt$10$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      roleId: role.id,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return {
    id: user.id,
    email,
    displayName: user.displayName,
    role: { id: role.id, name: role.name, isOwner },
    permissions: effectivePermissions(isOwner, isOwner ? ALL_PERMISSIONS : [...permissions]),
  };
}

export const ctx = (actor: Actor) => ({ actor, ip: '127.0.0.1' });
