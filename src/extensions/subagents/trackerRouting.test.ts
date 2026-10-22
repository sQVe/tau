import { expect, it } from 'vitest';

import type { OriginRepository } from '../../github/repositoryTarget.js';
import type { TrackerRepository, TrackerSetup } from './trackerConfig.js';
import { trackerLines } from './trackerRouting.js';

const repositories = (entries: Record<string, TrackerRepository>) =>
  new Map(Object.entries(entries));

const read = (
  agentTeam: string | undefined,
  entries: Record<string, TrackerRepository>,
): TrackerSetup => ({
  status: 'read',
  config: { agentTeam, repositories: repositories(entries) },
});

const tau = { team: 'ME', project: 'Tau' };

const named = (host: string): OriginRepository => ({
  status: 'named',
  repository: { host, owner: 'sQVe', name: 'tau' },
});

const origin = named('github.com');

it.each<{ condition: string; setup: TrackerSetup; origin: OriginRepository; lines: string[] }>([
  {
    condition: 'no tracker config',
    setup: { status: 'unset' },
    origin,
    lines: [],
  },
  {
    condition: 'an invalid config',
    setup: { status: 'invalid', message: 'Invalid Tau config /a/tau.json: tracker.x is bad.' },
    origin,
    lines: ['Tracker setup needed: Invalid Tau config /a/tau.json: tracker.x is bad.'],
  },
  {
    condition: 'an invalid config whose message holds a line break',
    setup: { status: 'invalid', message: 'Invalid key "a\n- injected line".' },
    origin,
    lines: ['Tracker setup needed: Invalid key "a - injected line".'],
  },
  {
    condition: 'a configured repository',
    setup: read('AI', { 'sQVe/tau': tau }),
    origin,
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.',
    ],
  },
  {
    condition: 'a configured repository without a project',
    setup: read('AI', { 'sQVe/tau': { team: 'ME', project: undefined } }),
    origin,
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker repository: `sQVe/tau` uses team `ME` and no project.',
    ],
  },
  {
    condition: 'an entry whose owner/name differs only in case',
    setup: read('AI', { 'sqve/Tau': tau }),
    origin,
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.',
    ],
  },
  {
    condition: 'no agent team',
    setup: read(undefined, { 'sQVe/tau': tau }),
    origin,
    lines: [
      'Tracker setup needed: tracker.agentTeam is not set.',
      'Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.',
    ],
  },
  {
    condition: 'a repository without an entry',
    setup: read('AI', { 'sQVe/other': tau }),
    origin,
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker setup needed: tracker.repositories has no entry for `sQVe/tau`.',
    ],
  },
  {
    condition: 'no origin remote',
    setup: read('AI', { 'sQVe/tau': tau }),
    origin: { status: 'missing' },
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker setup needed: this checkout has no origin remote, so no tracker.repositories entry applies.',
    ],
  },
  {
    condition: 'an origin on another host with a github.com entry of the same name',
    setup: read('AI', { 'sQVe/tau': tau }),
    origin: named('gitlab.com'),
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker setup needed: the origin remote is not on github.com, so no tracker.repositories entry applies.',
    ],
  },
  {
    condition: 'an origin that names no owner/name',
    setup: read('AI', { 'sQVe/tau': tau }),
    origin: { status: 'unnamed' },
    lines: [
      'Tracker agent team: `AI`.',
      'Tracker setup needed: the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.',
    ],
  },
])('gives the tracker lines for $condition', ({ setup, origin: originResult, lines }) => {
  expect(trackerLines({ setup, origin: originResult })).toEqual(lines);
});
