import { expect, it } from 'vitest';

import { ownsTerminal } from './ownerDecision.js';

const table = [
  {
    name: 'no foreground process',
    facts: { foregroundPid: undefined, processPid: 100 },
    owns: false,
  },
  {
    name: 'this process in the foreground',
    facts: { foregroundPid: 100, processPid: 100 },
    owns: true,
  },
  {
    name: 'the parent Pi in the foreground',
    facts: { foregroundPid: 100, processPid: 200 },
    owns: false,
  },
] as const;

it.each(table.map((row) => [row.name, row] as const))(
  'decides whether this process owns the terminal with %s',
  (_name, row) => {
    expect(ownsTerminal(row.facts)).toBe(row.owns);
  },
);
