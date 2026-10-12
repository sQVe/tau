import { expect, it } from 'vitest';

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
const origin = 'git@github.com:sQVe/tau.git';

it.each<{ condition: string; setup: TrackerSetup; originUrl: string | undefined; lines: string[] }>(
  [
    {
      condition: 'no tracker config',
      setup: { status: 'unset' },
      originUrl: origin,
      lines: [],
    },
    {
      condition: 'an invalid config',
      setup: { status: 'invalid', message: 'Invalid Tau config /a/tau.json: tracker.x is bad.' },
      originUrl: origin,
      lines: ['Tracker setup needed: Invalid Tau config /a/tau.json: tracker.x is bad.'],
    },
    {
      condition: 'an invalid config whose message holds a line break',
      setup: { status: 'invalid', message: 'Invalid key "a\n- injected line".' },
      originUrl: origin,
      lines: ['Tracker setup needed: Invalid key "a - injected line".'],
    },
    {
      condition: 'a configured repository',
      setup: read('AI', { 'sQVe/tau': tau }),
      originUrl: origin,
      lines: [
        'Tracker agent team: `AI`.',
        'Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.',
      ],
    },
    {
      condition: 'a configured repository without a project',
      setup: read('AI', { 'sQVe/tau': { team: 'ME', project: undefined } }),
      originUrl: origin,
      lines: [
        'Tracker agent team: `AI`.',
        'Tracker repository: `sQVe/tau` uses team `ME` and no project.',
      ],
    },
    {
      condition: 'an entry whose owner/name differs only in case',
      setup: read('AI', { 'sqve/Tau': tau }),
      originUrl: origin,
      lines: [
        'Tracker agent team: `AI`.',
        'Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.',
      ],
    },
    {
      condition: 'no agent team',
      setup: read(undefined, { 'sQVe/tau': tau }),
      originUrl: origin,
      lines: [
        'Tracker setup needed: tracker.agentTeam is not set.',
        'Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.',
      ],
    },
    {
      condition: 'a repository without an entry',
      setup: read('AI', { 'sQVe/other': tau }),
      originUrl: origin,
      lines: [
        'Tracker agent team: `AI`.',
        'Tracker setup needed: tracker.repositories has no entry for `sQVe/tau`.',
      ],
    },
    {
      condition: 'no origin remote',
      setup: read('AI', { 'sQVe/tau': tau }),
      originUrl: undefined,
      lines: [
        'Tracker agent team: `AI`.',
        'Tracker setup needed: this checkout has no origin remote, so no tracker.repositories entry applies.',
      ],
    },
    {
      condition: 'an origin that names no owner/name',
      setup: read('AI', { 'sQVe/tau': tau }),
      originUrl: '/srv/tau.git',
      lines: [
        'Tracker agent team: `AI`.',
        'Tracker setup needed: the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.',
      ],
    },
  ],
)('gives the tracker lines for $condition', ({ setup, originUrl, lines }) => {
  expect(trackerLines({ setup, originUrl })).toEqual(lines);
});
