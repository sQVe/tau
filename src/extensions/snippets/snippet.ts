import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Snippet {
  /** Markdown filename without `.md`, such as `ask-questions`. Listed as `#ask-questions`. */
  id: string;
  name: string;
  description: string;
  body: string;
}

// Header fields are optional, so an empty frontmatter block still parses.
const frontmatterPattern = /^---\r?\n((?:[\S\s]*?\r?\n)?)---\r?\n?([\S\s]*)$/;
const metadataPattern = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const quotePattern = /^["']|["']$/g;

/** Returns null when the file has no frontmatter block or no body text. */
const parseSnippet = (filename: string, raw: string): Snippet | null => {
  const id = filename.replace(/\.md$/i, '');
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

  const body = rest.replaceAll('\r\n', '\n').trim();

  if (body === '') {
    return null;
  }

  return {
    id,
    name: metadata.get('name') ?? id,
    description: metadata.get('description') ?? '',
    body,
  };
};

const compareSnippets = (first: Snippet, second: Snippet) => first.id.localeCompare(second.id);

/**
 * Reads every markdown snippet in `directory`, sorted by id.
 *
 * Throws when the directory or one of its files cannot be read. A failure here
 * means the package is incomplete, which the caller shows instead of an empty
 * list.
 */
export const loadSnippets = async (directory: string): Promise<Snippet[]> => {
  // A directory named `draft.md` would otherwise reach readFile and throw.
  const entries = await readdir(directory, { withFileTypes: true });

  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);

  const parsed = await Promise.all(
    filenames.map(async (filename) => {
      const content = await readFile(join(directory, filename), 'utf8');

      return parseSnippet(filename, content);
    }),
  );

  const snippets = parsed.filter((snippet) => snippet !== null);

  return snippets.toSorted(compareSnippets);
};
