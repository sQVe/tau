import type { OriginRepository } from '../../github/repositoryTarget.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import type { TrackerRoute, TrackerSetup } from './config.js';

export interface TrackerFacts {
  setup: TrackerSetup;
  origin: OriginRepository;
}

// The tracker skill finds these lines by prefix, so keep the prefixes stable.
const agentTeamPrefix = 'Tracker agent team:';
const repositoryPrefix = 'Tracker repository:';
const setupPrefix = 'Tracker setup needed:';

const agentTeamLine = (agentTeam: string | undefined): string =>
  agentTeam === undefined
    ? `${setupPrefix} tracker.agentTeam is not set.`
    : `${agentTeamPrefix} \`${agentTeam}\`.`;

const routeLine = (repository: string, route: TrackerRoute | undefined): string => {
  if (route === undefined) {
    return `${setupPrefix} tracker.repositories has no entry for \`${repository}\`.`;
  }

  const project = route.project === undefined ? 'no project' : `project \`${route.project}\``;

  return `${repositoryPrefix} \`${repository}\` uses team \`${route.team}\` and ${project}.`;
};

const repositoryLine = (route: TrackerRoute | undefined, origin: OriginRepository): string => {
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

  return routeLine(repository, route);
};

export const trackerLines = ({ setup, origin }: TrackerFacts): string[] => {
  if (setup.status === 'unset') {
    return [];
  }

  if (setup.status === 'invalid') {
    const message = setup.message.replaceAll(/\s+/gu, ' ');

    return [`${setupPrefix} ${message}`];
  }

  return [agentTeamLine(setup.agentTeam), repositoryLine(setup.route, origin)];
};
