import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Snippet, SnippetPlacement } from './types.js';

// The header is optional, so a snippet that sets no field still parses.
const frontmatterPattern = /^---\r?\n((?:[\S\s]*?\r?\n)?)---\r?\n?([\S\s]*)$/;
const metadataPattern = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const quotePattern = /^["']|["']$/g;

// Sorts last, so snippets without an order keep their relative order by name.
const defaultOrder = 9999;

const readPlacement = (value: string | undefined): SnippetPlacement =>
  value?.toLowerCase() === 'prepend' ? 'prepend' : 'append';

const readOrder = (value: string | undefined) => {
  const order = Number.parseInt(value ?? '', 10);
  return Number.isFinite(order) ? order : defaultOrder;
};

/** Returns null when the file has no frontmatter block or no body text. */
export const parseSnippet = (filename: string, raw: string): Snippet | null => {
  const frontmatter = frontmatterPattern.exec(raw);
  if (frontmatter === null) {
    return null;
  }

  const [, header = '', rest = ''] = frontmatter;
  const metadata = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const field = metadataPattern.exec(line);
    if (field === null) {
      continue;
    }

    const [, key = '', rawValue = ''] = field;
    const value = rawValue.trim().replace(quotePattern, '');
    if (value !== '') {
      metadata.set(key.toLowerCase(), value);
    }
  }

  // The menu splits the body on newlines, and a stray carriage return there
  // returns the cursor to column 0 and corrupts the frame.
  const body = rest.replaceAll('\r\n', '\n').trim();
  if (body === '') {
    return null;
  }

  return {
    id: filename,
    name: metadata.get('name') ?? filename.replace(/\.md$/i, ''),
    description: metadata.get('description') ?? '',
    placement: readPlacement(metadata.get('placement')),
    order: readOrder(metadata.get('order')),
    body,
  };
};

const compareSnippets = (a: Snippet, b: Snippet) =>
  a.order === b.order ? a.name.localeCompare(b.name) : a.order - b.order;

/**
 * Reads every markdown snippet in `directory`, sorted with the prepend group
 * first and each group ordered by `order`, then by name.
 *
 * Throws when the directory or one of its files cannot be read. A failure here
 * means the package is incomplete, and sending a message without the snippets
 * the user selected would be worse than a visible error.
 */
export const loadSnippets = async (directory: string): Promise<Snippet[]> => {
  // A directory named `draft.md` would otherwise reach readFile and throw.
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);
  const parsed = await Promise.all(
    filenames.map(async (name) =>
      parseSnippet(name, await readFile(join(directory, name), 'utf8')),
    ),
  );
  const snippets = parsed.filter((snippet) => snippet !== null);

  return [
    ...snippets.filter((snippet) => snippet.placement === 'prepend').toSorted(compareSnippets),
    ...snippets.filter((snippet) => snippet.placement === 'append').toSorted(compareSnippets),
  ];
};

/**
 * Pi expands `/skill:name` and prompt templates after the input handlers run,
 * and both require the command at the start of the text. Wrapping the text
 * would leave the command unexpanded, or turn an appended body into its
 * arguments, so snippets never apply to a message that starts with a slash.
 */
export const acceptsSnippets = (text: string) => !text.trimStart().startsWith('/');

/** Wraps `text` with the bodies of `active`, which must already be sorted. */
export const buildSnippetMessage = (text: string, active: Snippet[]): string => {
  const bodiesFor = (placement: SnippetPlacement) =>
    active.filter((snippet) => snippet.placement === placement).map((snippet) => snippet.body);

  return [...bodiesFor('prepend'), text, ...bodiesFor('append')].join('\n\n');
};
