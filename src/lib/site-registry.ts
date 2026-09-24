/**
 * Registry of editable website copy ("content blocks") and site settings.
 *
 * Only keys listed here can be stored; the staff panel renders one field per
 * entry. Content defaults are neutral, factual copy based on what Based
 * Productions has confirmed (plugins sold on BuiltByBit, support on Discord).
 * Settings have NO defaults: an unset link is shown as "not configured" rather
 * than replaced with a plausible-looking fake.
 */
import { BUILTBYBIT_HOSTS, DISCORD_HOSTS } from './validation.ts';

export type ContentKind = 'text' | 'markdown';

export interface ContentBlockDefinition {
  label: string;
  description: string;
  kind: ContentKind;
  maxLength: number;
  defaultValue: string;
}

export const CONTENT_BLOCKS = {
  'home.hero.title': {
    label: 'Homepage headline',
    description: 'The large headline at the top of the homepage.',
    kind: 'text',
    maxLength: 120,
    defaultValue: 'Plugins and server software for Minecraft.',
  },
  'home.hero.body': {
    label: 'Homepage introduction',
    description: 'One or two sentences under the homepage headline.',
    kind: 'text',
    maxLength: 400,
    defaultValue:
      'Based Productions builds Minecraft plugins and related server software. Products are sold on BuiltByBit, documented here, and supported through our Discord.',
  },
  'about.body': {
    label: 'About page text',
    description: 'Introduction on the About page, above the team list. Markdown.',
    kind: 'markdown',
    maxLength: 20_000,
    defaultValue:
      'Based Productions is a Minecraft development brand focused on creating and selling Minecraft plugins and related server software.\n\nProducts are sold through BuiltByBit, and customer support runs through our Discord server.',
  },
  'services.intro': {
    label: 'Services introduction',
    description: 'Text at the top of the Services page. Markdown.',
    kind: 'markdown',
    maxLength: 10_000,
    defaultValue:
      'Development services from Based Productions will be listed here as they become available.',
  },
  'support.intro': {
    label: 'Support introduction',
    description: 'Text at the top of the Support page. Markdown.',
    kind: 'markdown',
    maxLength: 10_000,
    defaultValue:
      'Support for Based Productions products happens on our Discord server, where you can open a support ticket.',
  },
  'support.checklist': {
    label: 'Support checklist',
    description: 'What customers should include when asking for help. Markdown list.',
    kind: 'markdown',
    maxLength: 10_000,
    defaultValue: [
      '- The product name and the version you are running',
      '- Your server software and Minecraft version',
      '- What you expected to happen, and what happened instead',
      '- Any errors from your server console or log, pasted as text rather than screenshots',
      '- Your BuiltByBit username if your question is about a purchase',
    ].join('\n'),
  },
  'footer.disclaimer': {
    label: 'Footer disclaimer',
    description: 'Small print in the site footer.',
    kind: 'text',
    maxLength: 300,
    defaultValue:
      'Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.',
  },
} as const satisfies Record<string, ContentBlockDefinition>;

export type ContentKey = keyof typeof CONTENT_BLOCKS;

export function isContentKey(value: unknown): value is ContentKey {
  return typeof value === 'string' && Object.hasOwn(CONTENT_BLOCKS, value);
}

export type SettingKind = 'url' | 'email';

export interface SettingDefinition {
  label: string;
  description: string;
  kind: SettingKind;
  /** For URL settings: the link must point to one of these domains. */
  hosts?: readonly string[];
  /** Shown on the staff dashboard checklist when unset. */
  recommended: boolean;
}

export const SETTINGS = {
  'links.discord': {
    label: 'Discord invite link',
    description:
      'Permanent invite to the Based Productions Discord server, where customer support happens.',
    kind: 'url',
    hosts: DISCORD_HOSTS,
    recommended: true,
  },
  'links.builtbybit': {
    label: 'BuiltByBit store link',
    description: 'Your BuiltByBit creator or store page, linked from the header and product pages.',
    kind: 'url',
    hosts: BUILTBYBIT_HOSTS,
    recommended: true,
  },
  'links.github': {
    label: 'GitHub',
    description: 'Optional. Organisation or profile link shown in the footer.',
    kind: 'url',
    hosts: ['github.com'],
    recommended: false,
  },
  'links.youtube': {
    label: 'YouTube',
    description: 'Optional. Channel link shown in the footer.',
    kind: 'url',
    hosts: ['youtube.com', 'youtu.be'],
    recommended: false,
  },
  'links.x': {
    label: 'X (Twitter)',
    description: 'Optional. Profile link shown in the footer.',
    kind: 'url',
    hosts: ['x.com', 'twitter.com'],
    recommended: false,
  },
  'contact.email': {
    label: 'Business contact email',
    description: 'Optional. Shown on the Support and About pages for non-support enquiries.',
    kind: 'email',
    recommended: false,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && Object.hasOwn(SETTINGS, value);
}
