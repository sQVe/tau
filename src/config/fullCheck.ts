import { isRecord } from '../schema.js';
import type { KnownKeys } from '../schema.js';
import {
  readTauConfig,
  requireKnownKey,
  setsKey,
  userConfigPath,
  warnUnknownKeys,
} from './config.js';
import type { ConfigFile, ConfigLocation, ConfigWarnings } from './config.js';

export interface RepositoryArgv {
  argv: string[] | undefined;
  ignored: string | undefined;
}

const knownSectionKeys: KnownKeys = { argv: true };

const readArgv = (source: string, field: string, value: unknown): string[] => {
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

const readSection = (ui: ConfigWarnings, source: string, key: string, value: unknown): string[] => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${key} must be an object such as {"argv": ["pnpm", "check"]}.`,
    );
  }

  warnUnknownKeys(ui, source, value, knownSectionKeys, key);

  return readArgv(source, `${key}.argv`, value.argv);
};

const sectionOf = ({ value }: ConfigFile, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

export const withIgnoredNote = (message: string, ignored: string | undefined): string =>
  ignored === undefined
    ? message
    : `${message} Tau ignored ${ignored} because the project is not trusted.`;

export const readRepositoryArgv = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  key: string,
): RepositoryArgv => {
  requireKnownKey(key);

  const { files, ignored } = readTauConfig(location);
  const userPath = userConfigPath(location.agentDirectory);
  const user = files.find((file) => file.source === userPath);

  if (user !== undefined && setsKey(user, key)) {
    throw new Error(
      `Invalid Tau config ${userPath}: ${key} belongs in .pi/tau.json in the repository. Move it there.`,
    );
  }

  const project = files.find((file) => file.source !== userPath && setsKey(file, key));

  if (project === undefined) {
    return { argv: undefined, ignored };
  }

  return { argv: readSection(ui, project.source, key, sectionOf(project, key)), ignored };
};
