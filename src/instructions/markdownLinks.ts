import { Marked } from 'marked';
import type { Token } from 'marked';

export interface MarkdownLinks {
  targets: readonly string[];
  slugs: ReadonlySet<string>;
}

export type Destination =
  | { kind: 'external' }
  | { kind: 'undecodable' }
  | { kind: 'local'; path: string; fragment: string | undefined };

const externalTarget = /^[a-z][a-z\d+.-]*:/i;

const headingLink = /\[([^\]]*)\]\([^)]*\)/g;
const notSlugCharacter = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

const tokenizer = new Marked();

const withoutByteOrderMark = (markdown: string) =>
  markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;

const slugOf = (heading: string) =>
  heading
    .replaceAll(headingLink, '$1')
    .replaceAll('`', '')
    .trim()
    .toLowerCase()
    .replaceAll(notSlugCharacter, '')
    .replaceAll(' ', '-');

export const headingSlugs = (headings: readonly string[]): ReadonlySet<string> => {
  const counts = new Map<string, number>();
  const slugs = new Set<string>();

  for (const heading of headings) {
    const base = slugOf(heading);
    let slug = base;

    while (slugs.has(slug)) {
      const count = (counts.get(base) ?? 0) + 1;

      counts.set(base, count);
      slug = `${base}-${count}`;
    }

    slugs.add(slug);
  }

  return slugs;
};

export const decodedComponent = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

export const readDestination = (target: string): Destination => {
  if (externalTarget.test(target)) {
    return { kind: 'external' };
  }

  const fragmentStart = target.indexOf('#');
  const fragment = fragmentStart === -1 ? undefined : target.slice(fragmentStart + 1);
  const reference = fragmentStart === -1 ? target : target.slice(0, fragmentStart);
  const queryStart = reference.indexOf('?');
  const encodedPath = queryStart === -1 ? reference : reference.slice(0, queryStart);
  const path = decodedComponent(encodedPath);

  if (path === undefined) {
    return { kind: 'undecodable' };
  }

  return { kind: 'local', path, fragment };
};

const targetOf = (token: Token): string | undefined => {
  if (token.type !== 'link' && token.type !== 'image' && token.type !== 'def') {
    return undefined;
  }

  const value: unknown = token.href;

  return typeof value === 'string' ? value : undefined;
};

const renderedText = (tokens: readonly Token[]): string =>
  tokens
    .map((token) => {
      if (token.type === 'image' || token.type === 'html') {
        return '';
      }

      if (token.type === 'text' || token.type === 'codespan' || token.type === 'escape') {
        const text: unknown = token.text;

        return typeof text === 'string' ? text : '';
      }

      const children: readonly Token[] | undefined = 'tokens' in token ? token.tokens : undefined;

      return children === undefined ? '' : renderedText(children);
    })
    .join('');

const headingTextOf = (token: Token): string | undefined => {
  if (token.type !== 'heading') {
    return undefined;
  }

  return renderedText(token.tokens ?? []);
};

export const readMarkdownLinks = (markdown: string): MarkdownLinks => {
  const targets: string[] = [];
  const headings: string[] = [];
  const tokens = tokenizer.lexer(withoutByteOrderMark(markdown));

  // oxlint-disable-next-line typescript/no-floating-promises -- The visit returns void, so the walk has no promise to handle.
  tokenizer.walkTokens(tokens, (token) => {
    const target = targetOf(token);

    if (target !== undefined) {
      targets.push(target);
    }

    const heading = headingTextOf(token);

    if (heading !== undefined) {
      headings.push(heading);
    }
  });

  return { targets, slugs: headingSlugs(headings) };
};
