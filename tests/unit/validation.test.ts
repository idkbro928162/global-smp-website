import { describe, expect, it } from 'vitest';
import {
  MINECRAFT_VERSION,
  isValidIsoDate,
  releaseVersionSchema,
  slugSchema,
  urlProblem,
} from '../../src/lib/validation.ts';

describe('urlProblem', () => {
  it('accepts https links to allowed hosts and their subdomains', () => {
    expect(urlProblem('https://builtbybit.com/resources/x.1/', ['builtbybit.com'])).toBeNull();
    expect(urlProblem('https://www.builtbybit.com/creators/x', ['builtbybit.com'])).toBeNull();
  });

  it.each([
    ['http://builtbybit.com/x', 'https'],
    ['https://builtbybit.com.evil.example/x', 'must point to'],
    ['https://evilbuiltbybit.com/x', 'must point to'],
    ['https://user:pass@builtbybit.com/x', 'username or password'],
    ['javascript:alert(1)', 'https'],
    ['not a url', 'full link'],
  ])('rejects %s', (url, message) => {
    expect(urlProblem(url, ['builtbybit.com'])).toContain(message);
  });
});

describe('slugSchema', () => {
  it('normalises case and accepts hyphenated slugs', () => {
    expect(slugSchema.parse('My-Plugin')).toBe('my-plugin');
  });

  it.each(['a', 'has space', 'double--hyphen', '-leading', 'trailing-', 'new', 'general', '../x'])(
    'rejects %s',
    (slug) => {
      expect(slugSchema.safeParse(slug).success).toBe(false);
    },
  );
});

describe('version formats', () => {
  it.each(['1.20.4', '1.21.x', '1.21+', '26.1', '26.1.2'])('accepts Minecraft version %s', (v) => {
    expect(MINECRAFT_VERSION.test(v)).toBe(true);
  });

  it.each(['1', 'latest', '1.21.x.y', '<script>'])('rejects Minecraft version %s', (v) => {
    expect(MINECRAFT_VERSION.test(v)).toBe(false);
  });

  it.each(['1.4.0', '2.0.0-beta.1', 'v3', '1.0.0+build.5'])('accepts release version %s', (v) => {
    expect(releaseVersionSchema.safeParse(v).success).toBe(true);
  });

  it.each(['', '-1.0', '1.0-', 'has space', '<b>'])('rejects release version %s', (v) => {
    expect(releaseVersionSchema.safeParse(v).success).toBe(false);
  });
});

describe('isValidIsoDate', () => {
  it('validates real calendar dates only', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2026-2-3')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});
