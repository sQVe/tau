import { readTauConfig, requireKnownKey } from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { readRepositorySection } from '../../config/repositorySection.js';
import { errorMessage } from '../../errors.js';
import { isRecord } from '../../schema.js';

export interface TrackerRoute {
  team: string;
  project: string | undefined;
}

export type TrackerSetup =
  | { status: 'unset' }
  | { status: 'invalid'; message: string }
  | { status: 'read'; agentTeam: string | undefined; route: TrackerRoute | undefined };

const teamKeyPattern = /^\S+$/u;
const projectPattern = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u;

const rejectSliceKey = (location: ConfigLocation): void => {
  requireKnownKey('slice');

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

const readRoute = (source: string, field: string, value: unknown): TrackerRoute => {
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

const readAgentTeam = (source: string, section: Record<string, unknown>): string | undefined => {
  if (section.agentTeam === undefined) {
    return undefined;
  }

  return readTeamKey(source, 'tracker.agentTeam', section.agentTeam);
};

const readTrackerConfig = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): TrackerSetup => {
  rejectSliceKey(location);

  const tracker = readRepositorySection(location, ui, {
    key: 'tracker',
    knownSectionKeys: { agentTeam: true },
    knownEntryKeys: { team: true, project: true },
    example: '{"agentTeam": "AI", "repositories": {}}',
    repository,
    readEntry: readRoute,
  });

  if (tracker === undefined) {
    return { status: 'unset' };
  }

  return {
    status: 'read',
    agentTeam: readAgentTeam(tracker.source, tracker.section),
    route: tracker.entry,
  };
};

export const readTrackerSetup = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): TrackerSetup => {
  try {
    return readTrackerConfig(location, ui, repository);
  } catch (error) {
    return { status: 'invalid', message: errorMessage(error) };
  }
};
