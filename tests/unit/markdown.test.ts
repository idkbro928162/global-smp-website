import { describe, expect, it } from 'vitest';
import { markdownToText, renderMarkdown, slugify } from '../../src/lib/markdown.ts';

const html = (source: string, baseLevel?: 2 | 3 | 4) => renderMarkdown(source, { baseLevel }).html;

describe('renderMarkdown — XSS safety', () => {
  it('escapes raw HTML instead of rendering it', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    '//evil.example/path',
  ])('does not turn %s into a link', (href) => {
    const out = html(`[click](${href})`);
    expect(out).not.toMatch(/<a /);
  });

  it('rejects javascript: autolinks', () => {
    expect(html('<javascript:alert(1)>')).not.toMatch(/<a /);
  });

  it('keeps safe links and marks external ones noopener', () => {
    const out = html(
      '[a](https://example.com) [b](/docs/x) [c](#top) [d](mailto:x@example.com) [e](guide/setup)',
    );
    expect(out).toContain('<a href="https://example.com" rel="noopener noreferrer">a</a>');
    expect(out).toContain('<a href="/docs/x">b</a>');
    expect(out).toContain('<a href="#top">c</a>');
    expect(out).toContain('<a href="mailto:x@example.com">d</a>');
    expect(out).toContain('<a href="guide/setup">e</a>');
  });

  it('only renders images uploaded to /media and falls back to alt text otherwise', () => {
    const out = html(
      '![tracker](https://evil.example/pixel.png) ![ok](/media/abcdefghijklmnopqrstuv-lg.webp)',
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('tracker');
    expect(out).toContain('<img src="/media/abcdefghijklmnopqrstuv-lg.webp" alt="ok"');
  });

  it('escapes HTML inside highlighted and plain code blocks', () => {
    const out = html('```yaml\nkey: "<b>v</b>"\n```\n\n```nosuchlang\n<script>x</script>\n```');
    expect(out).not.toContain('<b>v</b>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('language-yaml');
    // highlight.js emits class names only — no inline styles (CSP forbids them).
    expect(out).not.toContain('style=');
  });

  it('escapes attribute-breaking characters in image titles and alt text', () => {
    const out = html(
      '![a"onmouseover="x](/media/abcdefghijklmnopqrstuv-sm.webp "t\\"onload=\\"y")',
    );
    expect(out).not.toMatch(/"\s*onmouseover=/);
    expect(out).not.toMatch(/"\s*onload=/);
  });
});

describe('renderMarkdown — structure', () => {
  it('clamps headings to the base level and builds a table of contents', () => {
    const result = renderMarkdown('# Title\n\n## Setup\n\n### Details', { baseLevel: 2 });
    expect(result.html).toContain('<h2 id="title">');
    expect(result.html).toContain('<h2 id="setup">');
    expect(result.html).toContain('<h3 id="details">');
    expect(result.toc).toEqual([
      { id: 'title', text: 'Title', level: 2 },
      { id: 'setup', text: 'Setup', level: 2 },
      { id: 'details', text: 'Details', level: 3 },
    ]);
  });

  it('never emits h1/h2 when content sits under a page section (baseLevel 3)', () => {
    const out = html('# A\n\n## B', 3);
    expect(out).not.toMatch(/<h[12]/);
  });

  it('de-duplicates heading ids and avoids ids used by the layout', () => {
    const result = renderMarkdown('## Setup\n\n## Setup\n\n## Main content');
    const ids = result.toc.map((t) => t.id);
    expect(ids).toEqual(['setup', 'setup-1', 'main-content-1']);
  });

  it('does not nest links when a heading already contains one', () => {
    const out = html('## [Linked](https://example.com)');
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it('wraps tables in a keyboard-scrollable region', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain(
      '<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table>',
    );
  });

  it('handles empty input', () => {
    expect(renderMarkdown('').html).toBe('');
  });
});

describe('slugify / markdownToText', () => {
  it('slugifies text with accents and punctuation', () => {
    expect(slugify('Café — Setup & Config!')).toBe('cafe-setup-config');
    expect(slugify('!!!')).toBe('section');
  });

  it('extracts plain text and truncates on a word boundary', () => {
    expect(markdownToText('# Hello **world**\n\nSee [the docs](https://x.y).')).toBe(
      'Hello world See the docs.',
    );
    const long = markdownToText('word '.repeat(100), 30);
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long.endsWith('…')).toBe(true);
  });
});
