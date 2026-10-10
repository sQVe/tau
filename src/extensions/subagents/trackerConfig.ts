import { errorMessage } from '../../errors.js';
import { isRecord } from '../../isRecord.js';
import { readTauConfig, readUserOnlyKey, warnUnknownKeys } from '../../tauConfig.js';
import type { ConfigLocation, ConfigWarnings } from '../../tauConfig.js';
import { anyKey } from '../../unknownKeys.js';
import type { KnownKeys } from '../../unknownKeys.js';

export interface TrackerRepository {
  team: string;
  project: string | undefined;
}

export interface TrackerConfig {
  agentTeam: string | undefined;
  // Keyed by the origin remote's `owner/name`.
  repositories: Map<string, TrackerRepository>;
}

export type TrackerSetup =
  | { status: 'unset' }
  | { status: 'invalid'; message: string }
  | { status: 'read'; config: TrackerConfig };

// Team keys and project names become part of prompt lines, so neither may hold a line break.
const teamKeyPattern = /^\S+$/u;
// Control characters and the Unicode line and paragraph separators all break a line.
const projectPattern = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u;
const repositoryKeyPattern = /^[^\s/]+\/[^\s/]+$/u;

const knownTrackerKeys: KnownKeys = {
  agentTeam: true,
  repositories: { [anyKey]: { team: true, project: true } },
};

const rejectSliceKey = (location: ConfigLocation): void => {
  const file = readTauConfig(location).files.find(
    ({ value }) => isRecord(value) && Object.hasOwn(value, 'slice'),
  );

  if (file !== undefined) {
    throw new Error(
      `Invalid Tau config ${file.source}: slice is no longer read. Remove it, set the agent team as tracker.agentTeam, and add a tracker.repositories entry for each repository.`,
    );
  }
};

const readTeamKey = (source: string, field: string, value: unknown): string => {
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be a string.`);
  }

  if (!teamKeyPattern.test(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be a Linear team key such as "AI", with no spaces or line breaks.`,
    );
  }

  // Linear stores team keys in upper case, and its key filters compare case-sensitively.
  return value.toUpperCase();
};

const readProject = (source: string, field: string, value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be a string.`);
  }

  if (value.trim() === '') {
    throw new Error(`Invalid Tau config ${source}: ${field} must not be empty.`);
  }

  if (!projectPattern.test(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be a Linear project name with no line breaks.`,
    );
  }

  return value;
};

const readRepository = (source: string, key: string, value: unknown): TrackerRepository => {
  const field = `tracker.repositories.${key}`;

  if (!repositoryKeyPattern.test(key)) {
    throw new Error(
      `Invalid Tau config ${source}: ${JSON.stringify(key)} in tracker.repositories must be an owner/name such as "sQVe/tau".`,
    );
  }

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"team": "ME", "project": "Tau"}.`,
    );
  }

  return {
    team: readTeamKey(source, `${field}.team`, value.team),
    project: readProject(source, `${field}.project`, value.project),
  };
};

const sameRepository = (key: string, repository: string | undefined): boolean =>
  repository !== undefined && key.toLowerCase() === repository.toLowerCase();

// A bad entry fails only when it names `repository`, the checkout's own repository.
const readRepositories = (
  source: string,
  value: unknown,
  repository: string | undefined,
): Map<string, TrackerRepository> => {
  if (value === undefined) {
    return new Map();
  }

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: tracker.repositories must be an object keyed by owner/name, such as {"sQVe/tau": {"team": "ME"}}.`,
    );
  }

  const repositories = new Map<string, TrackerRepository>();

  // Every key counts, parsed or not, so the duplicate error does not depend on entry order.
  const seenKeys: string[] = [];

  for (const [key, entry] of Object.entries(value)) {
    const duplicate = seenKeys.find((earlier) => earlier.toLowerCase() === key.toLowerCase());

    // GitHub names ignore case, so two keys that differ only in case would name one repository.
    if (duplicate !== undefined) {
      throw new Error(
        `Invalid Tau config ${source}: tracker.repositories has both ${JSON.stringify(duplicate)} and ${JSON.stringify(key)}, which name the same repository. Keep one.`,
      );
    }

    seenKeys.push(key);

    try {
      repositories.set(key, readRepository(source, key, entry));
    } catch (error) {
      if (sameRepository(key, repository)) {
        throw error;
      }
    }
  }

  return repositories;
};

// The tracker names Linear teams the manager writes to, so only the user file may set it.
export const readTrackerConfig = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): TrackerConfig | undefined => {
  rejectSliceKey(location);

  const user = readUserOnlyKey(location, 'tracker');

  if (user === undefined) {
    return undefined;
  }

  const { source, value: tracker } = user;

  if (!isRecord(tracker)) {
    throw new Error(
      `Invalid Tau config ${source}: tracker must be an object such as {"agentTeam": "AI", "repositories": {}}.`,
    );
  }

  warnUnknownKeys(ui, source, tracker, knownTrackerKeys, 'tracker');

  const agentTeam =
    tracker.agentTeam === undefined
      ? undefined
      : readTeamKey(source, 'tracker.agentTeam', tracker.agentTeam);

  return { agentTeam, repositories: readRepositories(source, tracker.repositories, repository) };
};

// Prompt building cannot report an error, so an invalid config becomes a fact the prompt states.
export const readTrackerSetup = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): TrackerSetup => {
  try {
    const config = readTrackerConfig(location, ui, repository);

    return config === undefined ? { status: 'unset' } : { status: 'read', config };
  } catch (error) {
    return { status: 'invalid', message: errorMessage(error) };
  }
};
