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
    name: 'skips a value-taking cluster before -c',
    words: ['-euo', 'pipefail', '-c', 'git commit'],
    expected: { kind: 'inline', codes: ['git commit'] },
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
    name: 'keeps an unresolved word when a later -c decides the mode',
    words: ['$MODE', '-c', 'git commit'],
    expected: {
      kind: 'file',
      names: ['$MODE'],
      codes: ['git commit'],
      stdinMayBeCode: false,
    },
  },
  {
    name: 'keeps an ambiguous candidate before --',
    words: ['$MODE', '--'],
    expected: { kind: 'file', names: ['$MODE'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'adds the word after -- as code and file for a recorded candidate',
    words: ['$MODE', '--', 'script.sh'],
    expected: {
      kind: 'file',
      names: ['$MODE', 'script.sh'],
      codes: ['script.sh'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'reads the single candidate after -- and ignores the later words',
    words: ['--', 'script.sh', 'arg'],
    expected: { kind: 'file', names: ['script.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'adds the word after an empty-capable operand as a file candidate',
    words: ['--', '$SCRIPT', '$ARG'],
    expected: { kind: 'file', names: ['$SCRIPT', '$ARG'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'adds a literal script after an empty-capable operand as a file candidate',
    words: ['--', '$UNSET', 'commit.sh'],
    expected: { kind: 'file', names: ['$UNSET', 'commit.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'marks a length expansion after -- as never empty',
    words: ['--', `\${#SCRIPT}`],
    expected: { kind: 'file', names: [`\${#SCRIPT}`], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'marks a pid expansion after -- as never empty',
    words: ['--', '$$', 'commit.sh'],
    expected: { kind: 'file', names: ['$$'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps a positional suffix after -- as a literal file',
    words: ['--', '$1suffix'],
    expected: { kind: 'file', names: ['$1suffix'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps standard input as data when the following word cannot vanish',
    words: ['--', `\${UNSET:+}`, 'harmless.sh'],
    expected: {
      kind: 'file',
      names: [`\${UNSET:+}`, 'harmless.sh'],
      codes: [],
      stdinMayBeCode: false,
    },
  },
  {
    name: 'treats a lone dollar brace alternative as a file operand',
    words: ['{$,a}', '$DOC'],
    expected: { kind: 'file', names: ['{$,a}'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps a brace file when a later inline option decides the mode',
    words: ['{$FLAG,a}', '-c', 'true'],
    expected: {
      kind: 'file',
      names: ['{$FLAG,a}', 'a'],
      codes: ['a', 'true'],
      stdinMayBeCode: false,
    },
  },
  {
    name: 'keeps a brace file when a later stdin option decides the mode',
    words: ['{$FLAG,a}', '-s'],
    expected: { kind: 'file', names: ['{$FLAG,a}', 'a'], codes: ['a'], stdinMayBeCode: true },
  },
  {
    name: 'marks an operator expansion after -- as possibly empty',
    words: ['--', `\${UNSET:-}`],
    expected: { kind: 'file', names: [`\${UNSET:-}`], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'marks a brace with an expansion first alternative as an option',
    words: ['{$FLAG,a}'],
    expected: { kind: 'file', names: ['{$FLAG,a}', 'a'], codes: ['a'], stdinMayBeCode: true },
  },
  {
    name: 'marks a lone variable operand after -- as possibly empty',
    words: ['--', '$SCRIPT'],
    expected: { kind: 'file', names: ['$SCRIPT'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'keeps a mandatory file with literal text as never reading standard input',
    words: ['--', './$SCRIPT.sh'],
    expected: { kind: 'file', names: ['./$SCRIPT.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps a brace word that can be an option scanning',
    words: ['{-O,extglob}', 'script.sh'],
    expected: {
      kind: 'file',
      names: ['{-O,extglob}', 'script.sh'],
      codes: ['script.sh'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'marks a lone leading brace option as possibly reading standard input',
    words: ['{-O,extglob}'],
    expected: { kind: 'file', names: ['{-O,extglob}'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'keeps a nested value-taking option out of the file candidates',
    words: ['{{-O},extglob}'],
    expected: { kind: 'file', names: ['{{-O},extglob}'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'records the script after a flat value-taking option',
    words: ['{-O,extglob,commit.sh}'],
    expected: {
      kind: 'file',
      names: ['{-O,extglob,commit.sh}', 'commit.sh'],
      codes: [],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'records the script after a nested value-taking option',
    words: ['{{-O,extglob},commit.sh}'],
    expected: {
      kind: 'file',
      names: ['{{-O,extglob},commit.sh}', 'commit.sh'],
      codes: [],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'reads standard input for a trailing --',
    words: ['--'],
    expected: { kind: 'stdin', codes: [] },
  },
  {
    name: 'collects every vanishing operand and the first literal file',
    words: ['--', '$A', '$B', 'commit.sh'],
    expected: {
      kind: 'file',
      names: ['$A', '$B', 'commit.sh'],
      codes: [],
      stdinMayBeCode: false,
    },
  },
  {
    name: 'marks standard input when every operand after -- vanishes',
    words: ['--', '$A', '$B'],
    expected: { kind: 'file', names: ['$A', '$B'], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'marks a nested expansion after -- as possibly empty',
    words: ['--', `\${A:-\${B}}`],
    expected: { kind: 'file', names: [`\${A:-\${B}}`], codes: [], stdinMayBeCode: true },
  },
  {
    name: 'reads the file operand after a lone dash',
    words: ['-', 'script.sh'],
    expected: { kind: 'file', names: ['script.sh'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'reads standard input for a lone dash with no operand',
    words: ['-'],
    expected: { kind: 'stdin', codes: [] },
  },
  {
    name: 'records a flat option alternative as a file operand',
    words: ['{-e,script.sh}'],
    expected: {
      kind: 'file',
      names: ['{-e,script.sh}', 'script.sh'],
      codes: [],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'marks a braced zero as never empty',
    words: ['--', `\${0}`, 'harmless.sh'],
    expected: { kind: 'file', names: [`\${0}`], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'marks a braced status as never empty',
    words: ['--', `\${?}`, 'harmless.sh'],
    expected: { kind: 'file', names: [`\${?}`], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'marks a braced pid as never empty',
    words: ['--', `\${$}`, 'harmless.sh'],
    expected: { kind: 'file', names: [`\${$}`], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'marks an unresolved option word as possible standard input',
    words: ['-$FLAG', 'x'],
    expected: { kind: 'file', names: ['x'], codes: ['x'], stdinMayBeCode: true },
  },
  {
    name: 'adds an expansion brace alternative as code and file',
    words: ['{$FLAG,./commit.sh}'],
    expected: {
      kind: 'file',
      names: ['{$FLAG,./commit.sh}', './commit.sh'],
      codes: ['./commit.sh'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'adds a nested brace alternative as code',
    words: ['{{-c},$CMD}'],
    expected: {
      kind: 'file',
      names: ['{{-c},$CMD}'],
      codes: ['$CMD'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'adds a flat brace alternative as code',
    words: ['{-c,$CMD}'],
    expected: {
      kind: 'file',
      names: ['{-c,$CMD}'],
      codes: ['$CMD'],
      stdinMayBeCode: true,
    },
  },
  {
    name: 'keeps a status expansion after -- as never empty',
    words: ['--', '$?', 'harmless.sh'],
    expected: { kind: 'file', names: ['$?'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps a count expansion after -- as never empty',
    words: ['--', '$#', 'harmless.sh'],
    expected: { kind: 'file', names: ['$#'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps the shell name after -- as never empty',
    words: ['--', '$0', 'harmless.sh'],
    expected: { kind: 'file', names: ['$0'], codes: [], stdinMayBeCode: false },
  },
  {
    name: 'keeps a positional operand after -- as possibly empty',
    words: ['--', '$9', 'harmless.sh'],
    expected: { kind: 'file', names: ['$9', 'harmless.sh'], codes: [], stdinMayBeCode: false },
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

it('unwraps a deeply nested brace word without overflowing', () => {
  const word = '{'.repeat(20_000) + 'a' + '}'.repeat(20_000);

  const started = performance.now();
  const mode = shellMode([word]);
  const elapsed = performance.now() - started;

  expect(mode).toEqual({ kind: 'file', names: [word], codes: [], stdinMayBeCode: false });
  expect(elapsed).toBeLessThan(1000);
});

it('scans a long adversarial word without backtracking', () => {
  const word = '$' + '!$'.repeat(20_000) + ':';

  const started = performance.now();
  const mode = shellMode(['--', word]);
  const elapsed = performance.now() - started;

  expect(mode).toEqual({ kind: 'file', names: [word], codes: [], stdinMayBeCode: false });
  expect(elapsed).toBeLessThan(1000);
});

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(shellMode(row.words)).toEqual(row.expected);
});
