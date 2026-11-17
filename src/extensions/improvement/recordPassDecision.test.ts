import { expect, it } from 'vitest';

import type { EventGap, ImprovementEvent } from '../../improvement/event.js';
import { decidePassRoot } from './recordPassDecision.js';
import type { PassRootDecision } from './recordPassDecision.js';

const projectRoot = '/code/tau';

const readableEvent: ImprovementEvent = {
  version: 2,
  id: 'correction-1',
  kind: 'correction',
  createdAt: '2026-11-15T12:00:00.000Z',
  evidence: [],
  summary: 'Run the focused tests first.',
  cwd: projectRoot,
};

const malformedEvent: EventGap = {
  path: `${projectRoot}/.tau/improvement/broken.json`,
  reason: 'Malformed improvement event',
};

const unreadableEvent: EventGap = {
  path: `${projectRoot}/.tau/improvement/unreadable.json`,
  reason: 'Permission denied',
};

const passRootTable: {
  name: string;
  facts: {
    projectRoot: string;
    events: ImprovementEvent[];
    gaps: EventGap[];
  };
  expected: PassRootDecision;
}[] = [
  {
    name: 'writes to a root with a readable event',
    facts: { projectRoot, events: [readableEvent], gaps: [] },
    expected: { kind: 'write' },
  },
  {
    name: 'writes to a root with a readable event and an unreadable one',
    facts: { projectRoot, events: [readableEvent], gaps: [malformedEvent] },
    expected: { kind: 'write' },
  },
  {
    name: 'reports the first gap when no event is readable',
    facts: { projectRoot, events: [], gaps: [malformedEvent, unreadableEvent] },
    expected: {
      kind: 'failed',
      failure: { projectRoot, reason: `${malformedEvent.path}: ${malformedEvent.reason}` },
    },
  },
  {
    name: 'skips a root with no events and no gaps',
    facts: { projectRoot, events: [], gaps: [] },
    expected: { kind: 'skip' },
  },
];

it.each(passRootTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decidePassRoot(row.facts)).toEqual(row.expected);
});
