import { expect, it } from 'vitest';

import { noOwnerNotice, ownerWaitDelay, ownsTerminal } from './ownerDecision.js';

const ownerTable = [
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

it.each(ownerTable.map((row) => [row.name, row] as const))(
  'decides whether this process owns the terminal with %s',
  (_name, row) => {
    expect(ownsTerminal(row.facts)).toBe(row.owns);
  },
);

const waitTable = [
  { attempt: 0, delay: 500 },
  { attempt: 1, delay: 1_000 },
  { attempt: 2, delay: 2_000 },
  { attempt: 3, delay: 3_000 },
  { attempt: 4, delay: 4_000 },
  { attempt: 5, delay: undefined },
  { attempt: 9, delay: undefined },
] as const;

it.each(waitTable)('gives attempt $attempt the wait before the next owner check', (row) => {
  expect(ownerWaitDelay(row.attempt)).toBe(row.delay);
});

const noticeTable = [
  {
    name: 'another foreground process',
    facts: { terminal: 't7', foregroundPid: 400 },
    mentions: 'terminal t7 reports pid 400 in the foreground',
  },
  {
    name: 'no foreground process',
    facts: { terminal: 't7', foregroundPid: undefined },
    mentions: 'hc reports no foreground process for terminal t7',
  },
] as const;

it.each(noticeTable)('names $name in the notice that the inbox is off', (row) => {
  expect(noOwnerNotice(row.facts)).toContain(row.mentions);
});
