import { expect, it } from 'vitest';

import { tabName, tabRenameDecision } from './tabName.js';
import type { TabRenameFacts } from './tabName.js';

const maximumTabNameLength = 24;

const nameRows: { name: string; role: string; detail?: string; expected: string }[] = [
  { name: 'a lone role', role: 'lead', expected: 'lead' },
  { name: 'a lowercase role', role: 'Lead', detail: 'Designing', expected: 'lead: designing' },
  {
    name: 'a collapsed detail',
    role: 'scout',
    detail: '  Fix   status  counts ',
    expected: 'scout: fix status counts',
  },
  {
    name: 'a detail cut at a word',
    role: 'scout',
    detail: 'Review the PR feedback loop',
    expected: 'scout: review the pr',
  },
  {
    name: 'a hard-cut detail',
    role: 'worker',
    detail: 'supercalifragilisticexpialidocious',
    expected: 'worker: supercalifragili',
  },
  { name: 'an empty detail', role: 'lead', detail: '', expected: 'lead' },
  {
    name: 'a long role',
    role: 'averyveryverylongrolename1',
    detail: 'task',
    expected: 'averyveryverylongrolenam',
  },
];

it.each(nameRows)('names a tab for $name', ({ role, detail, expected }) => {
  expect(tabName(role, detail)).toBe(expected);
});

it('keeps every tab name at most 24 characters', () => {
  const lengths = nameRows.map((row) => tabName(row.role, row.detail).length);

  expect(Math.max(...lengths)).toBeLessThanOrEqual(maximumTabNameLength);
});

const renameRows: { name: string; facts: TabRenameFacts; expected: string | undefined }[] = [
  {
    name: 'a number name',
    facts: { role: 'lead', detail: undefined, currentName: '3', lastWrittenName: undefined },
    expected: 'lead',
  },
  {
    name: 'an empty name',
    facts: { role: 'architect', detail: undefined, currentName: '', lastWrittenName: undefined },
    expected: 'architect',
  },
  {
    name: 'a name Tau wrote',
    facts: { role: 'lead', detail: 'designing', currentName: 'lead', lastWrittenName: 'lead' },
    expected: 'lead: designing',
  },
  {
    name: 'the target name',
    facts: {
      role: 'lead',
      detail: 'designing',
      currentName: 'lead: designing',
      lastWrittenName: undefined,
    },
    expected: undefined,
  },
  {
    name: 'a hand name Tau wrote',
    facts: {
      role: 'lead',
      detail: 'reviewing',
      currentName: 'my notes',
      lastWrittenName: 'lead',
    },
    expected: undefined,
  },
  {
    name: 'a hand name Tau never wrote',
    facts: { role: 'lead', detail: undefined, currentName: 'my notes', lastWrittenName: undefined },
    expected: undefined,
  },
];

it.each(renameRows)('decides a rename for $name', ({ facts, expected }) => {
  expect(tabRenameDecision(facts)).toBe(expected);
});
