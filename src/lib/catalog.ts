/**
 * Fixed vocabularies used by product data. Extending a list here is enough to
 * make a new value selectable in the staff panel and renderable on the site.
 */

export const PLATFORMS = [
  { key: 'paper', label: 'Paper', kind: 'server' },
  { key: 'spigot', label: 'Spigot', kind: 'server' },
  { key: 'bukkit', label: 'Bukkit', kind: 'server' },
  { key: 'purpur', label: 'Purpur', kind: 'server' },
  { key: 'folia', label: 'Folia', kind: 'server' },
  { key: 'velocity', label: 'Velocity', kind: 'proxy' },
  { key: 'bungeecord', label: 'BungeeCord', kind: 'proxy' },
  { key: 'waterfall', label: 'Waterfall', kind: 'proxy' },
  { key: 'fabric', label: 'Fabric', kind: 'modded' },
  { key: 'neoforge', label: 'NeoForge', kind: 'modded' },
  { key: 'forge', label: 'Forge', kind: 'modded' },
] as const;

export type PlatformKey = (typeof PLATFORMS)[number]['key'];

export function isPlatformKey(value: unknown): value is PlatformKey {
  return PLATFORMS.some((p) => p.key === value);
}

export function platformLabel(key: PlatformKey): string {
  return PLATFORMS.find((p) => p.key === key)?.label ?? key;
}

/**
 * Curated product accent colours (named after Minecraft materials). Staff pick
 * one of these instead of entering arbitrary colours, which keeps the palette
 * controlled and lets the CSP forbid inline styles. Colours live in
 * src/styles/accents.css as `.accent-<key>` classes.
 */
export const ACCENTS = [
  { key: 'neutral', label: 'Graphite (neutral)' },
  { key: 'redstone', label: 'Redstone' },
  { key: 'copper', label: 'Copper' },
  { key: 'gold', label: 'Gold' },
  { key: 'emerald', label: 'Emerald' },
  { key: 'diamond', label: 'Diamond' },
  { key: 'lapis', label: 'Lapis' },
  { key: 'amethyst', label: 'Amethyst' },
] as const;

export type AccentKey = (typeof ACCENTS)[number]['key'];

export function isAccentKey(value: unknown): value is AccentKey {
  return ACCENTS.some((a) => a.key === value);
}

export const AVAILABILITY = {
  in_development: { label: 'In development', tone: 'pending' },
  available: { label: 'Available', tone: 'positive' },
  discontinued: { label: 'Discontinued', tone: 'muted' },
} as const;

export const RELEASE_CHANNELS = {
  stable: 'Stable',
  beta: 'Beta',
  alpha: 'Alpha',
} as const;

export const VISIBILITY = {
  draft: 'Draft',
  published: 'Published',
} as const;
