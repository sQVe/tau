import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readRepositorySection } from '../../config/repositorySection.js';
import { isRecord } from '../../isRecord.js';

export const readArgv = (source: string, field: string, value: unknown): string[] => {
  const expected = `${field} must be a non-empty array of non-empty strings, such as ["pnpm", "check"].`;

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid Tau config ${source}: ${expected}`);
  }

  const items = value.filter((item): item is string => typeof item === 'string' && item !== '');

  if (items.length !== value.length) {
    throw new Error(`Invalid Tau config ${source}: ${expected}`);
  }

  return items;
};

const readEntry = (source: string, field: string, value: unknown): string[] => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"argv": ["pnpm", "check"]}.`,
    );
  }

  return readArgv(source, `${field}.argv`, value.argv);
};

// Reads the command of the entry for `repository`. A bad entry for another repository is ignored.
// Resolves undefined when the repository has no entry.
export const readFullCheckArgv = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): string[] | undefined =>
  // Only the user file may name a command, since the check runs in every checkout of the user.
  readRepositorySection(location, ui, {
    key: 'fullCheck',
    knownEntryKeys: { argv: true },
    example: '{"repositories": {"sQVe/tau": {"argv": ["pnpm", "check"]}}}',
    repository,
    readEntry,
  });
