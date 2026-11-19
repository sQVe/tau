import { expect, it } from 'vitest';

import { ownsTerminal } from './ownerDecision.js';

const table = [
  {
    name: 'no foreground process',
    facts: { foregroundPid: undefined, processGroup: 500 },
    owns: false,
  },
  {
    name: 'a Pi started from a shell, which leads its group',
    facts: { foregroundPid: 500, processGroup: 500 },
    owns: true,
  },
  {
    name: 'a Pi run by pnpm exec, in the group of pnpm',
    facts: { foregroundPid: 400, processGroup: 400 },
    owns: true,
  },
  {
    name: 'a Pi started from the bash tool of another Pi',
    facts: { foregroundPid: 500, processGroup: 700 },
    owns: false,
  },
  {
    name: 'a Pi run by pnpm exec from the bash tool of another Pi',
    facts: { foregroundPid: 400, processGroup: 710 },
    owns: false,
  },
] as const;

it.each(table.map((row) => [row.name, row] as const))(
  'decides whether this process owns the terminal with %s',
  (_name, row) => {
    expect(ownsTerminal(row.facts)).toBe(row.owns);
  },
);
