import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { isRecord } from '../../schema.js';

export interface Snippet {
  /** Markdown filename without `.md`, such as `ask-questions`. Listed as `#ask-questions`. */
  id: string;
  name: string;
  description: string;
  body: string;
}

const malformedFrontmatter = (path: string, reason: string) =>
  new Error(`Snippet ${path} has malformed frontmatter: ${reason}`);

/** Pi's parser also accepts a block that only looks like frontmatter, so match the lines here. */
const hasFrontmatterBlock = (raw: string): boolean => {
  const lines = raw.replaceAll('\r\n', '\n').split('\n');

  if (lines[0] !== '---') {
    return false;
  }

  return lines.slice(1).includes('---');
};

const parseFrontmatterOrThrow = (path: string, raw: string) => {
  try {
    return parseFrontmatter(raw);
  } catch (error) {
    throw malformedFrontmatter(path, errorMessage(error));
  }
};

const readField = (
  metadata: Record<string, unknown>,
  key: string,
  fallback: string,
  path: string,
): string => {
  const value = metadata[key];

  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== 'string') {
    throw malformedFrontmatter(path, `${key} must be a string`);
  }

  const trimmed = value.trim();

  return trimmed === '' ? fallback : trimmed;
};

/** Returns null when the file has no frontmatter block or no body text. */
const parseSnippet = (path: string, raw: string): Snippet | null => {
  const id = basename(path).replace(/\.md$/i, '');

  if (!hasFrontmatterBlock(raw)) {
    return null;
  }

  const { frontmatter, body } = parseFrontmatterOrThrow(path, raw);

  if (!isRecord(frontmatter)) {
    throw malformedFrontmatter(path, 'frontmatter must be a mapping');
  }

  if (body === '') {
    return null;
  }

  return {
    id,
    name: readField(frontmatter, 'name', id, path),
    description: readField(frontmatter, 'description', '', path),
    body,
  };
};

const compareSnippets = (first: Snippet, second: Snippet) => first.id.localeCompare(second.id);

export const loadSnippets = async (directory: string): Promise<Snippet[]> => {
  // A directory named `draft.md` would otherwise reach readFile and throw.
  const entries = await readdir(directory, { withFileTypes: true });

  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name);

  const parsed = await Promise.all(
    filenames.map(async (filename) => {
      const path = join(directory, filename);
      const content = await readFile(path, 'utf8');

      return parseSnippet(path, content);
    }),
  );

  const snippets = parsed.filter((snippet) => snippet !== null);

  return snippets.toSorted(compareSnippets);
};
