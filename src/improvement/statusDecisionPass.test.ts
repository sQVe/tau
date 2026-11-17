import { expect, it } from 'vitest';

import type { ImprovementEvent } from './event.ts';
import { lastPassAt } from './statusDecision.ts';

const pass = (id: string, createdAt: string): ImprovementEvent => ({
  version: 2,
  id,
  kind: 'pass',
  createdAt,
  evidence: [],
  pass: 'correct',
});

const correction = (createdAt: string): ImprovementEvent => ({
  version: 2,
  id: 'correction-1',
  kind: 'correction',
  createdAt,
  evidence: [],
  summary: 'Run the focused tests first.',
  cwd: '/code/tau',
});

const passTable: {
  name: string;
  events: ImprovementEvent[];
  expected: string | undefined;
}[] = [
  {
    name: 'uses the newest pass event as the last pass',
    events: [
      pass('pass-earlier', '2026-11-15T12:00:00.000Z'),
      pass('pass-later', '2026-11-16T12:00:00.000Z'),
    ],
    expected: '2026-11-16T12:00:00.000Z',
  },
  {
    name: 'has no last pass without a pass event',
    events: [correction('2026-11-15T12:00:00.000Z')],
    expected: undefined,
  },
];

it.each(passTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(lastPassAt(row.events)).toBe(row.expected);
});
