import { decodeHTMLStrict, decodeXML } from 'entities';
import { Marked, Tokenizer } from 'marked';
import type { Token, Tokens } from 'marked';

export interface MarkdownLinks {
  targets: readonly string[];
  slugs: ReadonlySet<string>;
}

export type Destination =
  | { kind: 'external' }
  | { kind: 'undecodable' }
  | { kind: 'local'; path: string; fragment: string | undefined };

const externalTarget = /^[a-z][a-z\d+.-]*:/i;

const notSlugCharacter = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

const tokenizer = new Marked({
  tokenizer: {
    reflink(source, links) {
      const token = Tokenizer.prototype.reflink.call(this, source, links);

      return token?.type === 'link' || token?.type === 'image'
        ? { ...token, reference: true }
        : token;
    },
  },
});

const withoutByteOrderMark = (markdown: string) =>
  markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;

// GitHub renders a leading frontmatter block as a table, so it holds no heading.
const frontmatter = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

const withoutFrontmatter = (markdown: string) => markdown.replace(frontmatter, '');

const slugOf = (heading: string) =>
  heading.trim().toLowerCase().replaceAll(notSlugCharacter, '').replaceAll(' ', '-');

const headingSlugs = (headings: readonly string[]): ReadonlySet<string> => {
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

const isReferenceUse = (token: Token): boolean => {
  const reference: unknown = 'reference' in token ? token.reference : undefined;

  return reference === true;
};

const targetOf = (token: Token): string | undefined => {
  if (isReferenceUse(token)) {
    return undefined;
  }

  if (token.type !== 'link' && token.type !== 'image' && token.type !== 'def') {
    return undefined;
  }

  const value: unknown = token.href;

  return typeof value === 'string' ? value : undefined;
};

const tokenText = (token: Token): string => {
  const text: unknown = 'text' in token ? token.text : undefined;

  return typeof text === 'string' ? text : '';
};

// A rendered text token may still hold a character reference. Only one that ends with a semicolon
// is a reference, and a reference inside a code span stays literal.
const characterReference = /&(?:#\d{1,8}|#[xX][\da-fA-F]{1,8}|[A-Za-z][A-Za-z\d]*);/g;

// The HTML decoder remaps a numeric reference in the C1 range to a Windows-1252 letter, which
// GitHub does not.
const decodedReference = (reference: string): string =>
  reference.includes('#') ? decodeXML(reference) : decodeHTMLStrict(reference);

const decodedTokenText = (token: Token): string =>
  tokenText(token).replaceAll(characterReference, (reference) => decodedReference(reference));

export const markdownTokenText = (tokens: readonly Token[]): string =>
  tokens
    .map((token) => {
      if (token.type === 'image' || token.type === 'html') {
        return '';
      }

      if (token.type === 'br') {
        return '\n';
      }

      if (token.type === 'text') {
        return decodedTokenText(token);
      }

      if (token.type === 'codespan' || token.type === 'escape') {
        return tokenText(token);
      }

      const children: readonly Token[] | undefined = 'tokens' in token ? token.tokens : undefined;

      return children === undefined ? '' : markdownTokenText(children);
    })
    .join('');

const headingTextOf = (token: Token): string | undefined => {
  if (token.type !== 'heading') {
    return undefined;
  }

  return markdownTokenText(token.tokens ?? []);
};

const hasTableHeader = (token: Token): boolean => 'header' in token && Array.isArray(token.header);

const hasTableRows = (token: Token): boolean => 'rows' in token && Array.isArray(token.rows);

const hasTableCells = (token: Token): boolean => hasTableHeader(token) && hasTableRows(token);

export const isMarkdownTable = (token: Token): token is Tokens.Table =>
  token.type === 'table' && hasTableCells(token);

export const isMarkdownList = (token: Token): token is Tokens.List =>
  token.type === 'list' && 'items' in token && Array.isArray(token.items);

const childrenOf = (token: Token): readonly Token[] => {
  if (isMarkdownTable(token)) {
    const header = token.header.flatMap((cell) => cell.tokens);
    const rows = token.rows.flatMap((row) => row.flatMap((cell) => cell.tokens));

    return [...header, ...rows];
  }

  if (isMarkdownList(token)) {
    return token.items;
  }

  return 'tokens' in token ? token.tokens : [];
};

// Visits every token except code and html. Return false to skip the token's children.
// The optional after visit runs after the token's children.
export const walkMarkdownTokens = (
  tokens: readonly Token[],
  visit: (token: Token) => boolean | undefined,
  after?: (token: Token) => void,
): void => {
  for (const token of tokens) {
    if (token.type === 'code' || token.type === 'html') {
      continue;
    }

    if (visit(token) === false) {
      continue;
    }

    walkMarkdownTokens(childrenOf(token), visit, after);
    after?.(token);
  }
};

const collectLinks = (tokens: readonly Token[], targets: string[], headings: string[]): void => {
  walkMarkdownTokens(
    tokens,
    (token) => {
      const heading = headingTextOf(token);

      if (heading !== undefined) {
        headings.push(heading);
      }
    },
    (token) => {
      const target = targetOf(token);

      if (target !== undefined) {
        targets.push(target);
      }
    },
  );
};

export const readMarkdownLinks = (markdown: string): MarkdownLinks => {
  const targets: string[] = [];
  const headings: string[] = [];

  collectLinks(
    tokenizer.lexer(withoutFrontmatter(withoutByteOrderMark(markdown))),
    targets,
    headings,
  );

  return { targets, slugs: headingSlugs(headings) };
};
