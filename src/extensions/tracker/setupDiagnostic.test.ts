import { expect, it } from 'vitest';

import { trackerSetupDiagnostic } from './setupDiagnostic.js';
import type { TrackerFacts } from './setupDiagnostic.js';

const origin: TrackerFacts['origin'] = {
  status: 'named',
  repository: { host: 'github.com', owner: 'sQVe', name: 'tau' },
};

const route = { team: 'ME', project: 'Tau' };
const fallback = 'Tracker setup needed: configure tracker.repositories for this repository.';

const cases: { name: string; facts: TrackerFacts; kinds: string[]; problem: string }[] = [
  { name: 'unset', facts: { setup: { status: 'unset' }, origin }, kinds: [], problem: fallback },
  {
    name: 'invalid',
    facts: { setup: { status: 'invalid', message: 'Invalid\n  config\tvalue.' }, origin },
    kinds: ['problem'],
    problem: 'Tracker setup needed: Invalid config value.',
  },
  {
    name: 'configured',
    facts: { setup: { status: 'read', agentTeam: 'AI', route }, origin },
    kinds: ['agentTeam', 'repository'],
    problem: fallback,
  },
  {
    name: 'no project',
    facts: {
      setup: { status: 'read', agentTeam: 'AI', route: { team: 'ME', project: undefined } },
      origin,
    },
    kinds: ['agentTeam', 'repository'],
    problem: fallback,
  },
  {
    name: 'no agent team',
    facts: { setup: { status: 'read', agentTeam: undefined, route }, origin },
    kinds: ['problem', 'repository'],
    problem: 'Tracker setup needed: tracker.agentTeam is not set.',
  },
  {
    name: 'no route',
    facts: { setup: { status: 'read', agentTeam: 'AI', route: undefined }, origin },
    kinds: ['agentTeam', 'problem'],
    problem: 'Tracker setup needed: tracker.repositories has no entry for `sQVe/tau`.',
  },
  {
    name: 'missing both',
    facts: { setup: { status: 'read', agentTeam: undefined, route: undefined }, origin },
    kinds: ['problem', 'problem'],
    problem:
      'Tracker setup needed: tracker.agentTeam is not set.\nTracker setup needed: tracker.repositories has no entry for `sQVe/tau`.',
  },
  {
    name: 'missing origin',
    facts: { setup: { status: 'read', agentTeam: 'AI', route }, origin: { status: 'missing' } },
    kinds: ['agentTeam', 'problem'],
    problem:
      'Tracker setup needed: this checkout has no origin remote, so no tracker.repositories entry applies.',
  },
  {
    name: 'unnamed origin',
    facts: { setup: { status: 'read', agentTeam: 'AI', route }, origin: { status: 'unnamed' } },
    kinds: ['agentTeam', 'problem'],
    problem:
      'Tracker setup needed: the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.',
  },
  {
    name: 'another host',
    facts: {
      setup: { status: 'read', agentTeam: 'AI', route: undefined },
      origin: { status: 'named', repository: { host: 'gitlab.com', owner: 'sQVe', name: 'tau' } },
    },
    kinds: ['agentTeam', 'problem'],
    problem:
      'Tracker setup needed: the origin remote is not on github.com, so no tracker.repositories entry applies.',
  },
];

it.each(cases)('diagnoses $name', ({ facts, kinds, problem }) => {
  const diagnostic = trackerSetupDiagnostic(facts);

  expect(diagnostic.problem).toBe(problem);
  expect(diagnostic.entries.map((entry) => entry.kind)).toEqual(kinds);
});
