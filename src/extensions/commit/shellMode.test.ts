import { expect, it } from 'vitest';

import { shellMode } from './shellMode.js';
import type { ShellMode } from './shellMode.js';

const table: { name: string; words: string[]; expected: ShellMode }[] = [
  {
    name: 'reads standard input with no words',
    words: [],
    expected: { kind: 'stdin', codes: [] },
  },
  {
    name: 'reads separate code after -c',
    words: ['-c', 'git commit'],
    expected: { kind: 'inline', codes: ['git commit'] },
  },
  {
    name: 'reads attached code after -c',
    words: ['-cgit commit'],
    expected: { kind: 'inline', codes: ['git commit'] },
  },
  {
    name: 'reads code after a short-option cluster',
    words: ['-lc', 'git commit'],
    expected: { kind: 'inline', codes: ['git commit'] },
  },
  {
    name: 'reads standard input for -s',
    words: ['-s'],
    expected: { kind: 'stdin', codes: [] },
  },
  {
    name: 'skips a plain option before the file operand',
    words: ['--norc', 'script.sh'],
    expected: { kind: 'file', names: ['script.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'skips an option and its value before the file operand',
    words: ['--rcfile', 'profile.sh', 'script.sh'],
    expected: { kind: 'file', names: ['script.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'reads a literal file operand',
    words: ['script.sh'],
    expected: { kind: 'file', names: ['script.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'marks an ambiguous mode word as possibly reading standard input',
    words: ['$FLAG'],
    expected: { kind: 'file', names: ['$FLAG'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'keeps an unresolved word and the word after it as code',
    words: ['$MODE', 'code'],
    expected: { kind: 'file', names: ['$MODE', 'code'], codes: ['code'], stdinMayBeCode: true },
  },
  {
    name: 'keeps a later literal word as a second candidate',
    words: ['$FLAG', 'script.sh'],
    expected: {
      kind: 'file',
      names: ['$FLAG', 'script.sh'],
      codes: ['script.sh'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'keeps a last unresolved word as the only candidate',
    words: ['$SCRIPT'],
    expected: { kind: 'file', names: ['$SCRIPT'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'lets a later -c decide over an unresolved word',
    words: ['$MODE', '-c', 'git commit'],
    expected: { kind: 'inline', codes: ['-c', 'git commit'] },
  },
  {
    name: 'keeps an ambiguous candidate before --',
    words: ['$MODE', '--'],
    expected: { kind: 'file', names: ['$MODE'], codes: ['--'], stdinMayBeCode: true },
  },
  {
    name: 'adds the word after -- as code and file for a recorded candidate',
    words: ['$MODE', '--', 'script.sh'],
    expected: {
      kind: 'file',
      names: ['$MODE', 'script.sh'],
      codes: ['--', 'script.sh'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'reads the single candidate after -- and ignores the later words',
    words: ['--', 'script.sh', 'arg'],
    expected: { kind: 'file', names: ['script.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'reads a mandatory variable file after -- without code',
    words: ['--', '$SCRIPT', '$ARG'],
    expected: { kind: 'file', names: ['$SCRIPT'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'reads standard input for a trailing --',
    words: ['--'],
    expected: { kind: 'stdin', codes: [] },
  },
  {
    name: 'treats a word after -- as a file even when it looks like an option',
    words: ['--', '-c'],
    expected: { kind: 'file', names: ['-c'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'treats an unresolved brace word as a mandatory file operand',
    words: ['{a,b}/commit.sh', '--', '$CMD'],
    expected: {
      kind: 'file',
      names: ['{a,b}/commit.sh'],
      codes: [],
      stdinMayBeCode: false,
    },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(shellMode(row.words)).toEqual(row.expected);
});
