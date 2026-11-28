import { expect, it } from 'vitest';

import {
  blocksUnresolvedDecidingWord,
  isUnresolvedWord,
  startsWithExpansion,
} from './unresolvedWords.js';
import type { TextOrigin } from './unresolvedWords.js';

const wordTable: { name: string; word: string; expected: boolean }[] = [
  { name: 'treats a literal command name as resolved', word: 'git', expected: false },
  {
    name: 'treats a variable in a directory segment as resolved',
    word: '$VENV/bin/python',
    expected: false,
  },
  {
    name: 'treats a script file name behind a variable directory as resolved',
    word: '$NVM_DIR/nvm.sh',
    expected: false,
  },
  { name: 'treats a standalone closing brace as resolved', word: '}', expected: false },
  {
    name: 'treats a lone dollar in the last segment as resolved',
    word: 'data$.sh',
    expected: false,
  },
  { name: 'treats an unclosed backtick as resolved', word: '`x', expected: false },
  { name: 'treats a stray closing brace as resolved', word: 'a}b', expected: false },
  {
    name: 'treats a variable in a directory segment with a literal closing brace as resolved',
    word: '$DIR/x}',
    expected: false,
  },
  {
    name: 'treats a parameter expansion that closes in the last segment as unresolved',
    word: `\${A:-b/c}`,
    expected: true,
  },
  {
    name: 'treats a braced variable in a directory segment as resolved',
    word: `\${VENV}/bin/python`,
    expected: false,
  },
  {
    name: 'treats a brace expansion in a directory segment as unresolved',
    word: '{a,b}/commit.sh',
    expected: true,
  },
  { name: 'treats a variable as unresolved', word: '$CMD', expected: true },
  { name: 'treats a braced variable as unresolved', word: `\${CMD}`, expected: true },
  { name: 'treats a positional parameter as unresolved', word: '$1', expected: true },
  { name: 'treats a substitution as unresolved', word: '$(x)', expected: true },
  { name: 'treats a brace expression as unresolved', word: `\${A/b/c}`, expected: true },
  { name: 'treats a brace expansion as unresolved', word: '{git,commit}', expected: true },
  { name: 'treats a backtick as unresolved', word: '`x`', expected: true },
];

const gitTable: { name: string; words: string[]; gitIndex: number; expected: boolean }[] = [
  { name: 'allows a literal subcommand', words: ['git', 'log'], gitIndex: 0, expected: false },
  {
    name: 'allows a literal option before the subcommand',
    words: ['git', '--no-pager', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'skips the value of -C',
    words: ['git', '-C', '$DIR', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'skips the value of --git-dir',
    words: ['git', '--git-dir', '$DIR', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'skips the value of -c',
    words: ['git', '-c', '$CFG', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'blocks an attached --git-dir value that expands',
    words: ['git', '--git-dir=$DIR', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an attached -C value that expands',
    words: ['git', '-C$DIR', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'skips a literal attached --git-dir value',
    words: ['git', '--git-dir=/repo', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'blocks an attached --git-dir value that expands in a directory',
    words: ['git', '--git-dir=$DIR/x', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an attached -C value that expands in a directory',
    words: ['git', '-C$DIR/x', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'skips a literal attached -C value',
    words: ['git', '-C/repo', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'blocks an unresolved word before the subcommand',
    words: ['git', '$OPT', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an unresolved word after a literal option',
    words: ['git', '--no-pager', '$ACTION'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an unresolved subcommand after an attached value',
    words: ['git', '--git-dir=$DIR', '$ACTION', '-m', 'x'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an unresolved subcommand slot',
    words: ['git', '$ACTION', '-m', 'x'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'allows a variable after a literal subcommand',
    words: ['git', 'log', '--grep', '$X'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'reads the words after a wrapped git word',
    words: ['sudo', 'git', '$ACTION', 'log'],
    gitIndex: 1,
    expected: true,
  },
  {
    name: 'blocks a subcommand behind a directory expansion',
    words: ['git', '$X/commit'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an attached value in a short-option cluster',
    words: ['git', '-pC$DIR', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'skips a separate value in a short-option cluster',
    words: ['git', '-pC', '/repo', '$SUBCOMMIT'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'blocks an attached abbreviated long-option value',
    words: ['git', '--git-d=$DIR', 'log'],
    gitIndex: 0,
    expected: true,
  },
  {
    name: 'skips a separate abbreviated long-option value',
    words: ['git', '--git-d', '/repo', 'log'],
    gitIndex: 0,
    expected: false,
  },
  {
    name: 'allows an unmatched opening brace before the subcommand',
    words: ['git', 'x{y'],
    gitIndex: 0,
    expected: false,
  },
];

const originTable: {
  name: string;
  origin: TextOrigin;
  commandWord: string | undefined;
  laterWords: string[];
  expected: boolean;
}[] = [
  {
    name: 'allows a tool command with an unresolved command name',
    origin: { kind: 'toolCommand' },
    commandWord: '$CMD',
    laterWords: [],
    expected: false,
  },
  {
    name: 'allows a candidate script with an unresolved command name',
    origin: { kind: 'scriptCandidate' },
    commandWord: '$CMD',
    laterWords: [],
    expected: false,
  },
  {
    name: 'blocks shell code with an unresolved command name',
    origin: { kind: 'shellCode' },
    commandWord: '$CMD',
    laterWords: [],
    expected: true,
  },
  {
    name: 'allows shell code without a command word',
    origin: { kind: 'shellCode' },
    commandWord: undefined,
    laterWords: [],
    expected: false,
  },
  {
    name: 'allows shell code with a literal command name',
    origin: { kind: 'shellCode' },
    commandWord: 'echo',
    laterWords: ['$HOME'],
    expected: false,
  },
  {
    name: 'blocks shell code whose Git subcommand is unresolved',
    origin: { kind: 'shellCode' },
    commandWord: 'git',
    laterWords: ['$ACTION', '-m', 'x'],
    expected: true,
  },
  {
    name: 'allows shell code whose Git subcommand is literal',
    origin: { kind: 'shellCode' },
    commandWord: 'git',
    laterWords: ['log', '--grep', '$X'],
    expected: false,
  },
  {
    name: 'allows shell code whose Git option value is a variable',
    origin: { kind: 'shellCode' },
    commandWord: 'git',
    laterWords: ['-C', '$DIR', 'log'],
    expected: false,
  },
];

it.each(wordTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(isUnresolvedWord(row.word)).toBe(row.expected);
});

const startTable: { name: string; word: string; expected: boolean }[] = [
  { name: 'a variable', word: '$CMD', expected: true },
  { name: 'a lone dollar', word: '$', expected: false },
  { name: 'a variable after literal text', word: 'x$CMD', expected: false },
  { name: 'a closed backtick', word: '`x`', expected: true },
  { name: 'an unclosed backtick', word: '`x', expected: false },
];

it.each(startTable.map((row) => [row.name, row] as const))(
  'starts with expansion: %s',
  (_name, row) => {
    expect(startsWithExpansion(row.word)).toBe(row.expected);
  },
);

it.each(gitTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(
    blocksUnresolvedDecidingWord(
      { kind: 'shellCode' },
      row.words[row.gitIndex],
      row.words.slice(row.gitIndex + 1),
    ),
  ).toBe(row.expected);
});

it.each(originTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(blocksUnresolvedDecidingWord(row.origin, row.commandWord, row.laterWords)).toBe(
    row.expected,
  );
});
