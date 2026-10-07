import { expect, it } from 'vitest';

import {
  buildFixupSubject,
  fixupSubjectSearchWord,
  selectFixupTargetReference,
  validateGroupMessage,
} from './autosquash.js';
import type { CommitInput } from './validation.js';

it.each(['fixup', 'squash', 'amend'] as const)('builds the %s autosquash subject', (kind) => {
  expect(buildFixupSubject(kind, 'Original subject')).toBe(`${kind}! Original subject`);
});

it.each([
  { name: 'no candidates', candidates: [], expected: 'Original subject' },
  { name: 'empty subject', subject: '', candidates: [], expected: 'target-hash' },
  {
    name: 'leading whitespace',
    subject: ' Original subject',
    candidates: [],
    expected: 'target-hash',
  },
  {
    name: 'trailing whitespace',
    subject: 'Original subject ',
    candidates: [],
    expected: 'target-hash',
  },
  {
    name: 'autosquash prefix',
    subject: 'fixup! Original subject',
    candidates: [],
    expected: 'target-hash',
  },
  {
    name: 'padded candidate',
    candidates: [{ commitHash: 'other', subject: ' Original subject ' }],
    expected: 'target-hash',
  },
  {
    name: 'different subject',
    candidates: [{ commitHash: 'other', subject: 'Other subject' }],
    expected: 'Original subject',
  },
  {
    name: 'target itself',
    candidates: [{ commitHash: 'target-hash', subject: 'Original subject' }],
    expected: 'Original subject',
  },
  {
    name: 'duplicate',
    candidates: [{ commitHash: 'other', subject: 'Original subject' }],
    expected: 'target-hash',
  },
  {
    name: 'multiline first paragraph joined by Git',
    candidates: [{ commitHash: 'other', subject: 'Original subject continued' }],
    expected: 'target-hash',
    subject: 'Original subject continued',
  },
])('selects the target reference for $name', ({ candidates, expected, subject }) => {
  expect(selectFixupTargetReference(subject ?? 'Original subject', 'target-hash', candidates)).toBe(
    expected,
  );
});

it.each([
  { subject: '', word: '' },
  { subject: '   \t ', word: '' },
  { subject: 'fix: same subject', word: 'subject' },
  { subject: ' fix: same\nsubject  ', word: 'subject' },
])('selects a whitespace-free search word from $subject', ({ subject, word }) => {
  expect(fixupSubjectSearchWord(subject)).toBe(word);
});

const messageCases: {
  name: string;
  message: Omit<CommitInput['groups'][number], 'files'>;
  error?: RegExp;
}[] = [
  { name: 'conventional subject', message: { subject: 'fix: change' } },
  { name: 'fixup without body', message: { fixup: { kind: 'fixup', target: 'HEAD' } } },
  { name: 'squash without body', message: { fixup: { kind: 'squash', target: 'HEAD' } } },
  {
    name: 'amend replacement',
    message: { fixup: { kind: 'amend', target: 'HEAD' }, body: 'Replacement' },
  },
  {
    name: 'both choices',
    message: { subject: 'fix: change', fixup: { kind: 'fixup', target: 'HEAD' } },
    error: /both subject and fixup/,
  },
  { name: 'neither choice', message: {}, error: /subject or fixup is required/ },
  {
    name: 'missing replacement',
    message: { fixup: { kind: 'amend', target: 'HEAD' } },
    error: /amend requires a non-empty body/,
  },
  {
    name: 'blank replacement',
    message: { fixup: { kind: 'amend', target: 'HEAD' }, body: ' \r\n ' },
    error: /amend requires a non-empty body/,
  },
];

it.each(messageCases.filter(({ error }) => error === undefined))('accepts $name', ({ message }) => {
  expect(() => {
    validateGroupMessage({ files: ['file.txt'], ...message });
  }).not.toThrow();
});

it.each(messageCases.filter(({ error }) => error !== undefined))(
  'rejects $name',
  ({ message, error }) => {
    expect(() => {
      validateGroupMessage({ files: ['file.txt'], ...message });
    }).toThrow(error);
  },
);
