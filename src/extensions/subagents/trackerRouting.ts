import type { OriginRepository } from '../../github/repositoryTarget.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import type { TrackerConfig, TrackerSetup } from './trackerConfig.js';

export interface TrackerFacts {
  setup: TrackerSetup;
  origin: OriginRepository;
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

const repositoryLine = (config: TrackerConfig, origin: OriginRepository): string => {
  if (origin.status === 'missing') {
    return `${setupPrefix} this checkout has no origin remote, so no tracker.repositories entry applies.`;
  }

  if (origin.status === 'unnamed') {
    return `${setupPrefix} the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.`;
  }

  const repository = configRepositoryKey(origin.repository);

  if (repository === undefined) {
    return `${setupPrefix} the origin remote is not on github.com, so no tracker.repositories entry applies.`;
  }

  const entry = findRepository(config, repository);

  if (entry === undefined) {
    return `${setupPrefix} tracker.repositories has no entry for \`${repository}\`.`;
  }

  const project = entry.project === undefined ? 'no project' : `project \`${entry.project}\``;

  return `${repositoryPrefix} \`${repository}\` uses team \`${entry.team}\` and ${project}.`;
};

export const trackerLines = ({ setup, origin }: TrackerFacts): string[] => {
  if (setup.status === 'unset') {
    return [];
  }

  if (setup.status === 'invalid') {
    const message = setup.message.replaceAll(/\s+/gu, ' ');

    return [`${setupPrefix} ${message}`];
  }

  return [agentTeamLine(setup.config), repositoryLine(setup.config, origin)];
};
