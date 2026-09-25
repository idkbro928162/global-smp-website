/**
 * Staff permission catalogue.
 *
 * Permissions are fixed in code because code is what checks them. Roles are
 * stored in the database as named sets of these keys and can be edited by
 * staff holding `roles.manage` (subject to the escalation rules in
 * `src/server/services/roles.ts` and `src/server/services/users.ts`).
 *
 * The Owner role is special: it implicitly holds every permission, cannot be
 * edited or deleted, and only owners can grant or revoke it.
 */
export const PERMISSIONS = {
  'panel.access': {
    label: 'Access the staff panel',
    description: 'Required for every staff page. Without it, no other permission is usable.',
  },
  'products.manage': {
    label: 'Manage products',
    description: 'Create, edit, publish and delete products and their marketplace links.',
  },
  'releases.manage': {
    label: 'Manage releases',
    description: 'Create, edit, publish and delete product releases and changelogs.',
  },
  'docs.manage': {
    label: 'Manage documentation',
    description: 'Create, edit, publish and delete documentation pages.',
  },
  'content.manage': {
    label: 'Manage public content',
    description: 'Edit website copy blocks and the services listing.',
  },
  'team.manage': {
    label: 'Manage team page',
    description: 'Edit the public team profiles shown on the About page.',
  },
  'media.manage': {
    label: 'Manage media',
    description: 'Upload and delete images used by products, docs and team profiles.',
  },
  'staff.manage': {
    label: 'Manage staff accounts',
    description:
      'Invite staff, change their role, disable accounts and issue password reset links. Limited to accounts whose permissions you also hold.',
  },
  'roles.manage': {
    label: 'Manage roles and permissions',
    description: 'Create and edit roles. You can only grant permissions you hold yourself.',
  },
  'settings.manage': {
    label: 'Manage site settings',
    description: 'Edit the Discord, BuiltByBit, social and contact links used across the site.',
  },
  'audit.view': {
    label: 'View audit log',
    description: 'Read the history of administrative actions.',
  },
} as const satisfies Record<string, { label: string; description: string }>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && Object.hasOwn(PERMISSIONS, value);
}

/** Parses a stored permission list, silently dropping unknown or duplicate keys. */
export function parsePermissionList(raw: string | null | undefined): Permission[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter(isPermission))];
}

/** Default roles created on first start. They are ordinary, editable roles except Owner. */
export const DEFAULT_ROLES: {
  name: string;
  description: string;
  isOwner: boolean;
  permissions: Permission[];
}[] = [
  {
    name: 'Owner',
    description: 'Full access. Cannot be edited or deleted. Only owners can grant this role.',
    isOwner: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    name: 'Administrator',
    description: 'Manages content, staff accounts and settings. Cannot grant the Owner role.',
    isOwner: false,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    name: 'Editor',
    description: 'Manages products, releases, documentation, public content and media.',
    isOwner: false,
    permissions: [
      'panel.access',
      'products.manage',
      'releases.manage',
      'docs.manage',
      'content.manage',
      'team.manage',
      'media.manage',
    ],
  },
  {
    name: 'Documentation writer',
    description: 'Writes documentation and uploads the images it uses.',
    isOwner: false,
    permissions: ['panel.access', 'docs.manage', 'media.manage'],
  },
];
