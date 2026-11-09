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

export type LockScope = 'checkout' | 'repository';

export type RepositoryCommandKey = 'fullCheck' | 'mutation';

const knownSectionKeys: Readonly<Record<RepositoryCommandKey, KnownKeys>> = {
  fullCheck: { argv: true, lockScope: true },
  mutation: { argv: true },
};

const lockScopes: readonly LockScope[] = ['checkout', 'repository'];

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

const requireSectionObject = (
  source: string,
  key: string,
  value: unknown,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${key} must be an object such as {"argv": ["pnpm", "check"]}.`,
    );
  }

  return value;
};

const readSection = (
  ui: ConfigWarnings,
  source: string,
  key: RepositoryCommandKey,
  value: unknown,
): string[] => {
  const section = requireSectionObject(source, key, value);

  warnUnknownKeys(ui, source, section, knownSectionKeys[key], key);

  return readArgv(source, `${key}.argv`, section.argv);
};

const sectionOf = ({ value }: ConfigFile, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

export const withIgnoredNote = (message: string, ignored: string | undefined): string =>
  ignored === undefined
    ? message
    : `${message} Tau ignored ${ignored} because the project is not trusted.`;

const findRepositoryFile = (
  location: ConfigLocation,
  key: string,
): { project: ConfigFile | undefined; ignored: string | undefined } => {
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

  return { project, ignored };
};

export const readRepositoryArgv = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  key: RepositoryCommandKey,
): RepositoryArgv => {
  const { project, ignored } = findRepositoryFile(location, key);

  if (project === undefined) {
    return { argv: undefined, ignored };
  }

  return { argv: readSection(ui, project.source, key, sectionOf(project, key)), ignored };
};

const isLockScope = (value: unknown): value is LockScope =>
  lockScopes.some((scope) => scope === value);

// Full checks and mutation checks share one lock, so both read the scope from `fullCheck`.
export const readLockScope = (location: ConfigLocation): LockScope => {
  const { project } = findRepositoryFile(location, 'fullCheck');

  if (project === undefined) {
    return 'checkout';
  }

  const section = requireSectionObject(
    project.source,
    'fullCheck',
    sectionOf(project, 'fullCheck'),
  );

  const scope = section.lockScope;

  if (scope === undefined) {
    return 'checkout';
  }

  if (!isLockScope(scope)) {
    throw new Error(
      `Invalid Tau config ${project.source}: fullCheck.lockScope must be "checkout" or "repository".`,
    );
  }

  return scope;
};
