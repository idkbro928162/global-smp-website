/**
 * Markdown rendering for staff-authored content (product descriptions, docs,
 * release notes, copy blocks).
 *
 * This is the only place in the codebase that produces raw HTML for the page
 * (`SafeHtml`, rendered by src/components/Markdown.astro). Safety properties:
 *   - Raw HTML in the source is escaped (`html: false`), never passed through.
 *   - Links are limited to http(s), mailto, same-site paths and #anchors;
 *     `javascript:`, `data:` and other schemes render as plain text.
 *   - Images must be uploads served from /media/ — anything else renders as
 *     its alt text (the CSP would block external images anyway).
 *   - Code is highlighted by highlight.js, which escapes its input and emits
 *     class names only (no inline styles, so the CSP stays strict).
 * Staff are trusted to publish content, but a compromised or careless staff
 * account must not be able to inject script into pages other staff view.
 */
import MarkdownIt, {
  type Env,
  type MarkdownIt as MarkdownItInstance,
  type Token,
} from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import groovy from 'highlight.js/lib/languages/groovy';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import properties from 'highlight.js/lib/languages/properties';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

declare const safeHtmlBrand: unique symbol;
/** HTML produced by this module. Only this type may be rendered unescaped. */
export type SafeHtml = string & { readonly [safeHtmlBrand]: true };

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface RenderedMarkdown {
  html: SafeHtml;
  toc: TocEntry[];
}

export interface RenderOptions {
  /**
   * The lowest heading level the content may use. Pages render their own
   * <h1> (and sometimes <h2> sections), so content headings are clamped to
   * sit underneath them. Default 2.
   */
  baseLevel?: 2 | 3 | 4;
}

const LANGUAGES = {
  bash,
  diff,
  groovy,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  plaintext,
  properties,
  shell,
  sql,
  xml,
  yaml,
};
for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

const LANGUAGE_ALIASES: Record<string, keyof typeof LANGUAGES> = {
  sh: 'bash',
  zsh: 'bash',
  console: 'shell',
  terminal: 'shell',
  yml: 'yaml',
  toml: 'ini',
  conf: 'ini',
  cfg: 'ini',
  gradle: 'groovy',
  kts: 'kotlin',
  pom: 'xml',
  html: 'xml',
  js: 'javascript',
  txt: 'plaintext',
  text: 'plaintext',
  md: 'markdown',
};

/** Element ids used by the site layouts; headings must not reuse them. */
const RESERVED_IDS = new Set([
  'main-content',
  'site-header',
  'site-footer',
  'site-nav',
  'docs-nav',
  'on-this-page',
  'top',
]);

export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'section';
}

function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value === '') return false;
  if (value.startsWith('#')) return true;
  // Same-site paths. "//host" and "/\host" are protocol-relative in browsers.
  if (value.startsWith('/')) return !value.startsWith('//') && !value.startsWith('/\\');
  // Scheme-less relative paths ("guide/setup") contain no ":" before the first "/", "?" or "#".
  const firstDelimiter = value.search(/[/?#]/);
  const head = firstDelimiter === -1 ? value : value.slice(0, firstDelimiter);
  if (!head.includes(':')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function isSafeImageSrc(src: string): boolean {
  return /^\/media\/[A-Za-z0-9_-]+(?:-(?:sm|lg))?\.webp$/.test(src.trim());
}

function inlineText(token: Token | undefined): string {
  return (token?.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('');
}

interface RenderEnv extends Env {
  baseLevel: number;
  toc: TocEntry[];
  usedIds: Set<string>;
}

function createRenderer(): MarkdownItInstance {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.validateLink = isSafeHref;

  md.core.ruler.push('heading_ids', (state) => {
    const env = state.env as RenderEnv;
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open?.type !== 'heading_open') continue;
      const level = Math.min(6, Math.max(Number(open.tag.slice(1)), env.baseLevel));
      const close = tokens.slice(i).find((t) => t.type === 'heading_close');
      open.tag = `h${level}`;
      if (close) close.tag = `h${level}`;

      const inline = tokens[i + 1];
      const text = inlineText(inline).trim();
      let id = slugify(text);
      let n = 1;
      while (env.usedIds.has(id) || RESERVED_IDS.has(id)) id = `${slugify(text)}-${n++}`;
      env.usedIds.add(id);
      open.attrSet('id', id);
      // Self-links are skipped when the heading already contains a link
      // (nested <a> elements are invalid).
      const hasLink = inline?.children?.some((c) => c.type === 'link_open') ?? false;
      open.meta = { anchor: !hasLink };
      if (close) close.meta = { anchor: !hasLink };
      if ((level === 2 || level === 3) && level >= env.baseLevel && text) {
        env.toc.push({ id, text, level });
      }
    }
  });

  const escape = md.utils.escapeHtml;

  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    const html = self.renderToken(tokens, idx, options);
    const id = token.attrGet('id');
    return token.meta?.anchor && id != null
      ? `${html}<a class="heading-anchor" href="#${escape(String(id))}">`
      : html;
  };
  md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    return `${token.meta?.anchor ? '</a>' : ''}${self.renderToken(tokens, idx, options)}`;
  };

  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    const href = String(token.attrGet('href') ?? '');
    if (/^https?:/i.test(href)) token.attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]!;
    const src = String(token.attrGet('src') ?? '');
    const alt = inlineText(token) || token.content;
    if (!isSafeImageSrc(src)) return escape(alt);
    const title = token.attrGet('title');
    return `<img src="${escape(src)}" alt="${escape(alt)}"${
      title ? ` title="${escape(String(title))}"` : ''
    } loading="lazy" decoding="async">`;
  };

  md.renderer.rules.table_open = () =>
    '<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  const renderCode = (code: string, info: string) => {
    const requested = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const language =
      LANGUAGE_ALIASES[requested] ?? (Object.hasOwn(LANGUAGES, requested) ? requested : '');
    const body = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : escape(code);
    const label = language && language !== 'plaintext' ? requested : 'text';
    return (
      `<div class="code-block" data-code-block>` +
      `<div class="code-block__bar"><span class="code-block__lang">${escape(label)}</span></div>` +
      `<pre tabindex="0"><code class="hljs${language ? ` language-${escape(language)}` : ''}">${body}</code></pre>` +
      `</div>\n`
    );
  };
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]!;
    return renderCode(token.content, token.info);
  };
  md.renderer.rules.code_block = (tokens, idx) => renderCode(tokens[idx]!.content, '');

  return md;
}

const renderer = createRenderer();

export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const env: RenderEnv = { baseLevel: options.baseLevel ?? 2, toc: [], usedIds: new Set() };
  const html = renderer.render(source ?? '', env) as SafeHtml;
  return { html, toc: env.toc };
}

/** Plain-text excerpt of Markdown, for meta descriptions and previews. */
export function markdownToText(source: string, maxLength = 160): string {
  const tokens = renderer.parse(source ?? '', {
    baseLevel: 2,
    toc: [],
    usedIds: new Set(),
  } satisfies RenderEnv);
  const text = tokens
    .filter((t: Token) => t.type === 'inline')
    .map((t: Token) => inlineText(t))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
