import type { OriginRepository } from '../../github/repositoryTarget.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import type { TrackerRoute, TrackerSetup } from './config.js';

export interface TrackerFacts {
  setup: TrackerSetup;
  origin: OriginRepository;
}

export type TrackerSetupEntry =
  | { kind: 'agentTeam'; team: string }
  | { kind: 'repository'; repository: string; route: TrackerRoute }
  | { kind: 'problem'; message: string };

// The tracker skill finds this prefix, so keep it stable.
const setupPrefix = 'Tracker setup needed:';

const problemEntry = (message: string): TrackerSetupEntry => ({
  kind: 'problem',
  message: `${setupPrefix} ${message}`,
});

const agentTeamEntry = (team: string | undefined): TrackerSetupEntry =>
  team === undefined ? problemEntry('tracker.agentTeam is not set.') : { kind: 'agentTeam', team };

const repositoryEntry = (
  route: TrackerRoute | undefined,
  origin: OriginRepository,
): TrackerSetupEntry => {
  if (origin.status === 'missing') {
    return problemEntry(
      'this checkout has no origin remote, so no tracker.repositories entry applies.',
    );
  }

  if (origin.status === 'unnamed') {
    return problemEntry(
      'the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.',
    );
  }

  const repository = configRepositoryKey(origin.repository);

  if (repository === undefined) {
    return problemEntry(
      'the origin remote is not on github.com, so no tracker.repositories entry applies.',
    );
  }

  if (route === undefined) {
    return problemEntry(`tracker.repositories has no entry for \`${repository}\`.`);
  }

  return { kind: 'repository', repository, route };
};

const setupEntries = ({ setup, origin }: TrackerFacts): TrackerSetupEntry[] => {
  if (setup.status === 'unset') {
    return [];
  }

  if (setup.status === 'invalid') {
    const message = setup.message.replaceAll(/\s+/gu, ' ');

    return [problemEntry(message)];
  }

  return [agentTeamEntry(setup.agentTeam), repositoryEntry(setup.route, origin)];
};

export const trackerSetupDiagnostic = (
  facts: TrackerFacts,
): { entries: TrackerSetupEntry[]; problem: string } => {
  const entries = setupEntries(facts);
  const problems = entries.flatMap((entry) => (entry.kind === 'problem' ? [entry.message] : []));

  const problem =
    problems.join('\n') || `${setupPrefix} configure tracker.repositories for this repository.`;

  return { entries, problem };
};
