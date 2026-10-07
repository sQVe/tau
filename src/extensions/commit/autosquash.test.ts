import { expect, it } from 'vitest';

import { buildFixupSubject, validateGroupMessage } from './autosquash.js';
import type { CommitInput } from './validation.js';

it.each(['fixup', 'squash', 'amend'] as const)('builds the %s autosquash subject', (kind) => {
  expect(buildFixupSubject(kind, 'Original subject')).toBe(`${kind}! Original subject`);
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
