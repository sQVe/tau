import { expect, it } from 'vitest';

import { decideOwner } from './ownerDecision.js';
import type { OwnerFacts, OwnerVerdict } from './ownerDecision.js';

const deadlineMilliseconds = 10_000;

const table = [
  {
    name: 'a Pi started from a shell, which leads its group',
    facts: { foregroundPid: 500, processGroup: 500, elapsedMilliseconds: 0 },
    verdict: 'owner',
  },
  {
    name: 'a Pi run by pnpm exec, in the group of pnpm',
    facts: { foregroundPid: 400, processGroup: 400, elapsedMilliseconds: 0 },
    verdict: 'owner',
  },
  {
    name: 'a Pi started from the bash tool of another Pi',
    facts: { foregroundPid: 500, processGroup: 700, elapsedMilliseconds: 0 },
    verdict: 'notOwner',
  },
  {
    name: 'a Pi run by pnpm exec from the bash tool of another Pi',
    facts: { foregroundPid: 400, processGroup: 710, elapsedMilliseconds: 0 },
    verdict: 'notOwner',
  },
  {
    name: 'no foreground process before the deadline',
    facts: { foregroundPid: undefined, processGroup: 500, elapsedMilliseconds: 9_999 },
    verdict: 'wait',
  },
  {
    name: 'no foreground process at the deadline',
    facts: { foregroundPid: undefined, processGroup: 500, elapsedMilliseconds: 10_000 },
    verdict: 'noForeground',
  },
  {
    name: 'a foreign foreground process after the deadline',
    facts: { foregroundPid: 600, processGroup: 500, elapsedMilliseconds: 10_001 },
    verdict: 'notOwner',
  },
] as const satisfies readonly {
  name: string;
  facts: Omit<OwnerFacts, 'deadlineMilliseconds'>;
  verdict: OwnerVerdict;
}[];

it.each(table.map((row) => [row.name, row] as const))(
  'decides whether this process owns the terminal with %s',
  (_name, row) => {
    expect(decideOwner({ ...row.facts, deadlineMilliseconds })).toBe(row.verdict);
  },
);
