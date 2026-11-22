import { Marked } from 'marked';
import type { Token } from 'marked';

export interface MarkdownLinks {
  targets: readonly string[];
  slugs: ReadonlySet<string>;
}

const headingLink = /\[([^\]]*)\]\([^)]*\)/g;
const notSlugCharacter = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

// Pi's TUI registers extensions on the shared `marked` default instance, so a private instance
// keeps them out of this read.
const tokenizer = new Marked();

const withoutByteOrderMark = (markdown: string) =>
  markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;

// GitHub keeps the rendered text of a heading, so code and link markup do not reach the slug.
const slugOf = (heading: string) =>
  heading
    .replaceAll(headingLink, '$1')
    .replaceAll('`', '')
    .trim()
    .toLowerCase()
    .replaceAll(notSlugCharacter, '')
    .replaceAll(' ', '-');

// GitHub numbers repeated slugs from the second one on and skips numbers another heading already
// took: `Notes`, `Notes`, `Notes-1` give `notes`, `notes-1`, `notes-1-1`.
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

const targetOf = (token: Token): string | undefined => {
  if (token.type !== 'link' && token.type !== 'image' && token.type !== 'def') {
    return undefined;
  }

  const value: unknown = token.href;

  return typeof value === 'string' ? value : undefined;
};

const headingTextOf = (token: Token): string | undefined => {
  if (token.type !== 'heading') {
    return undefined;
  }

  const value: unknown = token.text;

  return typeof value === 'string' ? value : undefined;
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
