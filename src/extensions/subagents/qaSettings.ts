import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readRepositorySection } from '../../config/repositorySection.js';
import { isRecord } from '../../schema.js';

export interface QaSettings {
  urlCommand: string | undefined;
  testAccountCommand: string | undefined;
  dataWrites: boolean;
  // The config file the settings came from, named in refusals.
  source: string;
}

const readCommand = (source: string, field: string, value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be a string.`);
  }

  if (!value.trim()) {
    throw new Error(`Invalid Tau config ${source}: ${field} is empty.`);
  }

  return value;
};

const readDataWrites = (source: string, field: string, value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be true or false.`);
  }

  return value;
};

const readEntry = (source: string, field: string, value: unknown): QaSettings => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"urlCommand": "./scripts/dev-url"}.`,
    );
  }

  return {
    urlCommand: readCommand(source, `${field}.urlCommand`, value.urlCommand),
    testAccountCommand: readCommand(
      source,
      `${field}.testAccountCommand`,
      value.testAccountCommand,
    ),
    dataWrites: readDataWrites(source, `${field}.dataWrites`, value.dataWrites),
    source,
  };
};

// Reads the QA settings of the entry for `repository`. A bad entry for another repository is
// ignored. Resolves undefined when the repository has no entry. Only the user file may set `qa`,
// since it names commands that run in every checkout of the user.
export const readQaSettings = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): QaSettings | undefined =>
  readRepositorySection(location, ui, {
    key: 'qa',
    knownEntryKeys: { urlCommand: true, testAccountCommand: true, dataWrites: true },
    example: '{"repositories": {"sQVe/cape": {"urlCommand": "./scripts/dev-url"}}}',
    repository,
    readEntry,
  })?.entry;
