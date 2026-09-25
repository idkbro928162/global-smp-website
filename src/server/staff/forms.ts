/**
 * Conversions between HTML form submissions and service inputs for the
 * larger staff forms. "Values" are what the form displays (strings, so an
 * invalid submission can be re-rendered exactly as typed); services validate
 * the derived input with their zod schemas.
 */
import { LIMITS } from '../../lib/validation.ts';
import type { ProductDetail, ProductFeature } from '../services/products.ts';
import type { TeamLink, TeamMember } from '../services/team.ts';
import { checked, field, fields } from './page.ts';

// ---------------------------------------------------------------- products

export interface ProductFormValues {
  name: string;
  slug: string;
  tagline: string;
  description: string;
  visibility: string;
  availability: string;
  featured: boolean;
  sortOrder: string;
  accent: string;
  artworkId: string;
  features: ProductFeature[];
  minecraftVersions: string;
  platforms: string[];
  javaVersion: string;
  builtbybitUrl: string;
  externalDocsUrl: string;
  supportUrl: string;
  launchedOn: string;
  screenshotIds: string[];
}

export function emptyProductValues(): ProductFormValues {
  return {
    name: '',
    slug: '',
    tagline: '',
    description: '',
    visibility: 'draft',
    availability: 'in_development',
    featured: false,
    sortOrder: '0',
    accent: 'neutral',
    artworkId: '',
    features: [],
    minecraftVersions: '',
    platforms: [],
    javaVersion: '',
    builtbybitUrl: '',
    externalDocsUrl: '',
    supportUrl: '',
    launchedOn: '',
    screenshotIds: [],
  };
}

export function productValues(product: ProductDetail): ProductFormValues {
  return {
    name: product.name,
    slug: product.slug,
    tagline: product.tagline,
    description: product.description,
    visibility: product.visibility,
    availability: product.availability,
    featured: product.featured,
    sortOrder: String(product.sortOrder),
    accent: product.accent,
    artworkId: product.artwork?.id ?? '',
    features: product.features,
    minecraftVersions: product.minecraftVersions.join(', '),
    platforms: product.platforms,
    javaVersion: product.javaVersion,
    builtbybitUrl: product.builtbybitUrl,
    externalDocsUrl: product.externalDocsUrl,
    supportUrl: product.supportUrl,
    launchedOn: product.launchedOn ?? '',
    screenshotIds: product.screenshots.map((s) => s.id),
  };
}

/** Reads numbered row fields ("features.0.title", …) until a row is missing. */
function readRows<K extends string>(
  form: FormData,
  prefix: string,
  keys: readonly K[],
  max: number,
): Record<K, string>[] {
  const rows: Record<K, string>[] = [];
  for (let i = 0; i < max; i++) {
    if (!form.has(`${prefix}.${i}.${keys[0]}`)) break;
    const row = Object.fromEntries(
      keys.map((k) => [k, field(form, `${prefix}.${i}.${k}`)]),
    ) as Record<K, string>;
    rows.push(row);
  }
  return rows;
}

const isBlankRow = (row: Record<string, string>) => Object.values(row).every((v) => !v.trim());

export function productValuesFromForm(form: FormData): ProductFormValues {
  return {
    name: field(form, 'name'),
    slug: field(form, 'slug'),
    tagline: field(form, 'tagline'),
    description: field(form, 'description'),
    visibility: field(form, 'visibility'),
    availability: field(form, 'availability'),
    featured: checked(form, 'featured'),
    sortOrder: field(form, 'sortOrder'),
    accent: field(form, 'accent'),
    artworkId: field(form, 'artworkId'),
    features: readRows(form, 'features', ['title', 'body'] as const, LIMITS.maxFeatures + 8).filter(
      (row) => !isBlankRow(row),
    ),
    minecraftVersions: field(form, 'minecraftVersions'),
    platforms: fields(form, 'platforms'),
    javaVersion: field(form, 'javaVersion'),
    builtbybitUrl: field(form, 'builtbybitUrl'),
    externalDocsUrl: field(form, 'externalDocsUrl'),
    supportUrl: field(form, 'supportUrl'),
    launchedOn: field(form, 'launchedOn'),
    screenshotIds: fields(form, 'screenshotIds'),
  };
}

/** Splits "1.20.4, 1.21.x 26.1" into version tokens. */
export function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function productInput(values: ProductFormValues) {
  return { ...values, minecraftVersions: splitList(values.minecraftVersions) };
}

// -------------------------------------------------------------------- team

export interface TeamFormValues {
  name: string;
  roleTitle: string;
  bio: string;
  avatarId: string;
  links: TeamLink[];
  sortOrder: string;
  visibility: string;
}

export function emptyTeamValues(): TeamFormValues {
  return {
    name: '',
    roleTitle: '',
    bio: '',
    avatarId: '',
    links: [],
    sortOrder: '0',
    visibility: 'draft',
  };
}

export function teamValues(member: TeamMember): TeamFormValues {
  return {
    name: member.name,
    roleTitle: member.roleTitle,
    bio: member.bio,
    avatarId: member.avatar?.id ?? '',
    links: member.links,
    sortOrder: String(member.sortOrder),
    visibility: member.visibility,
  };
}

export function teamValuesFromForm(form: FormData): TeamFormValues {
  return {
    name: field(form, 'name'),
    roleTitle: field(form, 'roleTitle'),
    bio: field(form, 'bio'),
    avatarId: field(form, 'avatarId'),
    links: readRows(form, 'links', ['label', 'url'] as const, LIMITS.maxLinks + 4).filter(
      (row) => !isBlankRow(row),
    ),
    sortOrder: field(form, 'sortOrder'),
    visibility: field(form, 'visibility'),
  };
}
