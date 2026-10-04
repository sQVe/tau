import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Mirrors Pi's unexported read path normalizer, which the read tool applies before it opens a file.
const normalizeReadPath = (path: string): string => {
  const spaced = path.replace(unicodeSpaces, ' ');
  const unprefixed = spaced.startsWith('@') ? spaced.slice(1) : spaced;

  if (unprefixed === '~') {
    return homedir();
  }

  if (unprefixed.startsWith('~/')) {
    return join(homedir(), unprefixed.slice(2));
  }

  if (unprefixed.startsWith('file://')) {
    return fileURLToPath(unprefixed);
  }

  return unprefixed;
};

export const resolveReadPath = (cwd: string, path: string): string =>
  resolve(cwd, normalizeReadPath(path));
