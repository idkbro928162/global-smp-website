/**
 * Bootstraps a staff Owner account from the server command line.
 *
 * There is no default administrator and no password is ever passed on the
 * command line (it would end up in shell history). Instead this prints a
 * one-time setup link, valid for 72 hours, where the owner chooses their own
 * password.
 *
 * Usage:
 *   npm run staff:create-owner -- --email you@example.com --name "Your Name"
 *
 * Reads SITE_URL and DATA_DIR from the environment (or .env).
 */
import { parseArgs } from 'node:util';
import { getConfig } from '../src/server/config.ts';
import { getDb } from '../src/server/db/client.ts';
import { createOwnerInvite } from '../src/server/services/staff-accounts.ts';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
  },
});

if (!values.email || !values.name) {
  console.error('Usage: npm run staff:create-owner -- --email you@example.com --name "Your Name"');
  process.exit(1);
}

const config = getConfig();
const result = createOwnerInvite(getDb(), { email: values.email, displayName: values.name });
if (!result.ok) {
  for (const [field, message] of Object.entries(result.errors)) {
    console.error(`${field}: ${message}`);
  }
  process.exit(1);
}

const { link, existingOwners } = result.value;
if (existingOwners > 0) {
  console.warn(`Note: ${existingOwners} active owner account(s) already exist.`);
}
console.info(`Owner account created for ${values.email} (not active until the password is set).`);
console.info('Open this one-time link to choose a password. Do not share it.');
console.info(`Expires: ${link.expiresAt.toISOString()}`);
console.info('');
console.info(`  ${config.siteUrl}/staff/setup/${link.token}`);
console.info('');
