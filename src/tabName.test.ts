import { array, assert, constantFrom, property } from 'fast-check';
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
  {
    name: 'a detail cut inside an emoji',
    role: 'lead',
    detail: 'abcdefghijklmnopq😀',
    expected: 'lead: abcdefghijklmnopq',
  },
  {
    name: 'a role cut inside an emoji',
    role: 'abcdefghijklmnopqrstuvw😀',
    detail: 'task',
    expected: 'abcdefghijklmnopqrstuvw',
  },
  { name: 'an empty detail', role: 'lead', detail: '', expected: 'lead' },
  {
    name: 'a long role',
    role: 'averyveryverylongrolename1',
    detail: 'task',
    expected: 'averyveryverylongrolenam',
  },
  {
    name: 'a cut role ending in a space',
    role: 'abcdefghijklmnopqrstuvw xyz',
    detail: 'task',
    expected: 'abcdefghijklmnopqrstuvw',
  },
  {
    name: 'a word cut at the budget edge',
    role: 'lead',
    detail: 'abcdefghijklmnopq xyz',
    expected: 'lead: abcdefghijklmnopq',
  },
  {
    name: 'a one-character detail',
    role: 'abcdefghijklmnopqrstu',
    detail: 'xy',
    expected: 'abcdefghijklmnopqrstu: x',
  },
  {
    name: 'a detail cut away by the budget',
    role: 'abcdefghijklmnopqrstu',
    detail: '😀',
    expected: 'abcdefghijklmnopqrstu',
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
    name: 'the target name Tau wrote',
    facts: {
      role: 'lead',
      detail: 'designing',
      currentName: 'lead: designing',
      lastWrittenName: 'lead: designing',
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
  {
    name: 'a whitespace name',
    facts: { role: 'lead', detail: undefined, currentName: '   ', lastWrittenName: undefined },
    expected: 'lead',
  },
  {
    name: 'a two-digit name',
    facts: { role: 'lead', detail: undefined, currentName: '12', lastWrittenName: undefined },
    expected: 'lead',
  },
  {
    name: 'a digit-then-letter name',
    facts: { role: 'lead', detail: undefined, currentName: '1a', lastWrittenName: undefined },
    expected: undefined,
  },
  {
    name: 'a digits-then-letter name',
    facts: { role: 'lead', detail: undefined, currentName: '12a', lastWrittenName: undefined },
    expected: undefined,
  },
  {
    name: 'a letter-then-digits name',
    facts: { role: 'lead', detail: undefined, currentName: 'a12', lastWrittenName: undefined },
    expected: undefined,
  },
];

it.each(renameRows)('decides a rename for $name', ({ facts, expected }) => {
  expect(tabRenameDecision(facts)).toBe(expected);
});

const textCharacters = constantFrom('a', 'B', 'c', ' ', '\t', '-', '1', 'Z');

const generatedText = array(textCharacters, { minLength: 25, maxLength: 40 }).map((characters) =>
  characters.join(''),
);

it('keeps a generated name in the tab shape', () => {
  assert(
    property(generatedText, generatedText, (role, detail) => {
      const name = tabName(role, detail);

      expect(name).toBe(name.toLowerCase());
      expect(name).toBe(name.trim());
      expect(name.length).toBeLessThanOrEqual(maximumTabNameLength);
    }),
  );
});

it('keeps a generated tab name on a second decision', () => {
  assert(
    property(generatedText, generatedText, (role, detail) => {
      const name = tabName(role, detail);

      const decision = tabRenameDecision({
        role,
        detail,
        currentName: name,
        lastWrittenName: name,
      });

      expect(decision).toBeUndefined();
    }),
  );
});
