import { expect, it } from 'vitest';

import { hasOnlyLineEndingWarnings } from './lineEndingWarning.js';

const crlfWarning =
  "warning: in the working copy of 'file.txt', CRLF will be replaced by LF the next time Git touches it";

const lfWarning =
  "warning: in the working copy of 'file.txt', LF will be replaced by CRLF the next time Git touches it";

it.each([
  { name: 'empty stderr', stderr: '', expected: true },
  { name: 'whitespace-only stderr', stderr: '  \n\t\n', expected: true },
  { name: 'one CRLF warning', stderr: `${crlfWarning}\n`, expected: true },
  { name: 'one LF warning', stderr: `${lfWarning}\n`, expected: true },
  {
    name: 'several warnings for different files',
    stderr: `${crlfWarning}\n${lfWarning.replace('file.txt', 'other.txt')}\n`,
    expected: true,
  },
  { name: 'a warning with padding around it', stderr: `  ${lfWarning}  \n\n`, expected: true },
  {
    name: 'a newline in the file name',
    stderr: `${crlfWarning.replace('file.txt', 'line\nname.txt')}\n`,
    expected: true,
  },
  {
    name: 'other text between two warnings',
    stderr: `${crlfWarning}\nfatal: boom\n${lfWarning}\n`,
    expected: false,
  },
  { name: 'other stderr text', stderr: 'fatal: not a git repository\n', expected: false },
  {
    name: 'a different warning',
    stderr: "warning: could not open directory 'private/': Permission denied\n",
    expected: false,
  },
  { name: 'a warning plus other text', stderr: `${crlfWarning}\nfatal: boom\n`, expected: false },
  {
    name: 'a warning with its ending cut off',
    stderr: "warning: in the working copy of 'file.txt', CRLF will be replaced by LF\n",
    expected: false,
  },
  {
    name: 'a warning that does not start the line',
    stderr: `note: ${crlfWarning}\n`,
    expected: false,
  },
])('decides $name', ({ stderr, expected }) => {
  expect(hasOnlyLineEndingWarnings(stderr)).toBe(expected);
});
