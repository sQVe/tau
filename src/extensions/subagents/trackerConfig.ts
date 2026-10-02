import { errorMessage } from '../../errors.js';
import { isRecord, readTauConfig, readUserOnlyKey } from '../../tauConfig.js';
import type { ConfigLocation } from '../../tauConfig.js';

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

  return value;
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

  const unknownKey = Object.keys(value).find((name) => name !== 'team' && name !== 'project');

  if (unknownKey !== undefined) {
    throw new Error(
      `Invalid Tau config ${source}: ${field}.${unknownKey} is not a known key. Set only team and project.`,
    );
  }

  return {
    team: readTeamKey(source, `${field}.team`, value.team),
    project: readProject(source, `${field}.project`, value.project),
  };
};

const readRepositories = (source: string, value: unknown): Map<string, TrackerRepository> => {
  if (value === undefined) {
    return new Map();
  }

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: tracker.repositories must be an object keyed by owner/name, such as {"sQVe/tau": {"team": "ME"}}.`,
    );
  }

  const repositories = new Map<string, TrackerRepository>();

  for (const [key, repository] of Object.entries(value)) {
    const duplicate = [...repositories.keys()].find(
      (earlier) => earlier.toLowerCase() === key.toLowerCase(),
    );

    // GitHub names ignore case, so two keys that differ only in case would name one repository.
    if (duplicate !== undefined) {
      throw new Error(
        `Invalid Tau config ${source}: tracker.repositories has both ${JSON.stringify(duplicate)} and ${JSON.stringify(key)}, which name the same repository. Keep one.`,
      );
    }

    repositories.set(key, readRepository(source, key, repository));
  }

  return repositories;
};

// The tracker names Linear teams the manager writes to, so only the user file may set it.
export const readTrackerConfig = (location: ConfigLocation): TrackerConfig | undefined => {
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

  const unknownKey = Object.keys(tracker).find(
    (key) => key !== 'agentTeam' && key !== 'repositories',
  );

  if (unknownKey !== undefined) {
    throw new Error(
      `Invalid Tau config ${source}: tracker.${unknownKey} is not a known key. Set only agentTeam and repositories.`,
    );
  }

  const agentTeam =
    tracker.agentTeam === undefined
      ? undefined
      : readTeamKey(source, 'tracker.agentTeam', tracker.agentTeam);

  return { agentTeam, repositories: readRepositories(source, tracker.repositories) };
};

// Prompt building cannot report an error, so an invalid config becomes a fact the prompt states.
export const readTrackerSetup = (location: ConfigLocation): TrackerSetup => {
  try {
    const config = readTrackerConfig(location);

    return config === undefined ? { status: 'unset' } : { status: 'read', config };
  } catch (error) {
    return { status: 'invalid', message: errorMessage(error) };
  }
};
