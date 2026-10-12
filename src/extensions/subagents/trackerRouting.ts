import { repositoryFromRemote } from '../../repositoryRemote.js';
import type { TrackerConfig, TrackerSetup } from './trackerConfig.js';

export interface TrackerFacts {
  setup: TrackerSetup;
  originUrl: string | undefined;
}

// The tracker skill finds these lines by prefix, so keep the prefixes stable.
const agentTeamPrefix = 'Tracker agent team:';
const repositoryPrefix = 'Tracker repository:';
const setupPrefix = 'Tracker setup needed:';

const agentTeamLine = ({ agentTeam }: TrackerConfig): string =>
  agentTeam === undefined
    ? `${setupPrefix} tracker.agentTeam is not set.`
    : `${agentTeamPrefix} \`${agentTeam}\`.`;

// GitHub treats owner and repository names without regard to case.
const findRepository = ({ repositories }: TrackerConfig, repository: string) =>
  [...repositories].find(([key]) => key.toLowerCase() === repository.toLowerCase())?.[1];

const repositoryLine = (config: TrackerConfig, originUrl: string | undefined): string => {
  if (originUrl === undefined) {
    return `${setupPrefix} this checkout has no origin remote, so no tracker.repositories entry applies.`;
  }

  const repository = repositoryFromRemote(originUrl);

  if (repository === undefined) {
    return `${setupPrefix} the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.`;
  }

  const entry = findRepository(config, repository);

  if (entry === undefined) {
    return `${setupPrefix} tracker.repositories has no entry for \`${repository}\`.`;
  }

  const project = entry.project === undefined ? 'no project' : `project \`${entry.project}\``;

  return `${repositoryPrefix} \`${repository}\` uses team \`${entry.team}\` and ${project}.`;
};

export const trackerLines = ({ setup, originUrl }: TrackerFacts): string[] => {
  if (setup.status === 'unset') {
    return [];
  }

  if (setup.status === 'invalid') {
    const message = setup.message.replaceAll(/\s+/gu, ' ');

    return [`${setupPrefix} ${message}`];
  }

  return [agentTeamLine(setup.config), repositoryLine(setup.config, originUrl)];
};
