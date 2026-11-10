import { trackerSetupDiagnostic } from './setupDiagnostic.js';
import type { TrackerFacts, TrackerSetupEntry } from './setupDiagnostic.js';

// The tracker skill finds these lines by prefix, so keep the prefixes stable.
const agentTeamPrefix = 'Tracker agent team:';
const repositoryPrefix = 'Tracker repository:';

const entryLine = (entry: TrackerSetupEntry): string => {
  switch (entry.kind) {
    case 'agentTeam': {
      return `${agentTeamPrefix} \`${entry.team}\`.`;
    }

    case 'repository': {
      const project =
        entry.route.project === undefined ? 'no project' : `project \`${entry.route.project}\``;

      return `${repositoryPrefix} \`${entry.repository}\` uses team \`${entry.route.team}\` and ${project}.`;
    }

    case 'problem': {
      return entry.message;
    }

    default: {
      return entry satisfies never;
    }
  }
};

export const trackerLines = (facts: TrackerFacts): string[] => {
  const diagnostic = trackerSetupDiagnostic(facts);

  return diagnostic.entries.map(entryLine);
};
