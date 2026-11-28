import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { gitEnvironment } from '../../git.js';
import { readTextWithinSync } from '../../record.js';
import { parseShellCommands, quoteShellArgument } from '../../shell/shell.js';
import type { ShellCommand, ShellInput } from '../../shell/shell.js';
import { splitEnvString } from '../../wrapperAnalysis.js';

export type NamedFileFacts =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'nativeBinary' }
  | { kind: 'oversize'; head: string }
  | { kind: 'text'; text: string };

export type NamedFileVerdict = 'allow' | 'inspect' | 'block';

interface NamedScript {
  name: string;
  // An interpreter always runs shell code, so only a directly executed file needs its shebang read.
  checksShebang: boolean;
  // Resolves the name and the scripts it names, as the shell's working directory does.
  cwd: string;
  // The entries a bare name is looked up in.
  pathDirectories: string[];
  // A `.` or `source` operand resolves through PATH before the working directory.
  pathFirst: boolean;
}

type ShellMode =
  | { kind: 'inline'; code: string | undefined }
  | { kind: 'file'; name: string }
  | { kind: 'stdin' };

interface GuardState {
  // Resolved path to the facts read from it, so each path is read once per call.
  facts: Map<string, NamedFileFacts>;
  reads: number;
  // The PATH entries to search for an interpreter operand without a path separator.
  pathDirectories: string[];
}

type InterpreterSources =
  | {
      readonly kind: 'sources';
      readonly files: string[];
      readonly code: string[];
      readonly pathFirst?: boolean;
    }
  | { readonly kind: 'unreadable' };

// A wrapper positional word before the command word, skipped unless one of its options is present.
interface PositionalSkip {
  count: number;
  unless: ReadonlySet<string>;
}

type WrapperScan =
  | {
      readonly kind: 'command';
      // The assignment words the shell applies before the command, in source order.
      readonly assignments: string[];
      // The shell code of every command option seen, in source order.
      readonly codes: string[];
      // Where the wrapped command word starts, when a command follows.
      readonly commandIndex: number | undefined;
    }
  | {
      // A command option's value names its program through a variable expansion.
      readonly kind: 'unreadable';
      readonly assignments: string[];
      readonly codes: string[];
    };

type WrapperStep =
  | { kind: 'code'; code: string; next: number }
  | { kind: 'unreadable' }
  | { kind: 'skip'; next: number }
  | { kind: 'command' };

interface WrapperProgress {
  positionals: number;
  sawUnless: boolean;
}

type WrapperWord =
  | { kind: 'code'; code: string; next: number }
  | { kind: 'unreadable' }
  | { kind: 'skip'; next: number }
  | { kind: 'assignment'; word: string }
  | { kind: 'positional' }
  | { kind: 'command' };

interface ShortOption {
  letters: string;
  // What is attached to the letters, such as `./commit.sh` in `-lc./commit.sh`.
  tail: string;
}

type PathState =
  | { kind: 'missing' }
  | { kind: 'present' }
  | { kind: 'failed'; facts: NamedFileFacts };

// `env -S` splits its value with its own word rules, so a quoted value stays one word. A value that
// depends on the environment cannot be resolved, so the shell's word rules recover the words. When
// the recovered program word itself needs the environment, the file may run any program, so the
// caller cannot allow it.
type EnvSplitWords =
  | { readonly kind: 'words'; readonly words: readonly string[] }
  | { readonly kind: 'unreadable' };

type ShebangInterpreter =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'unreadable' };

export const commitGuardReason =
  'Blocked git commit via bash. Use the `commit` tool instead. To amend the last commit when it is not a merge or root commit, run `git reset --soft HEAD~1`, then call `commit` with the files of both changes. To fix up an older commit, call `commit` with the `fixup` field (kind `fixup`, `squash`, or `amend`) for the fix, then run `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base>`.';

// Used only when the command does not parse. It matches `commit` anywhere after `git` in a
// statement, so it blocks mentions in quoted text too.
const gitCommitPattern = /\bgit\b[^;|&\n]*(?<![\w/-])commit(?![\w/])|\bgit-commit\b/i;

// Commands that may run a string or standard input as shell code. When one runs in executable
// position, every word and heredoc body in that source is parsed as a script too, because piped
// data such as `echo 'git commit' | sh` becomes code.
const shellRunnerNames = new Set([
  '.',
  'ash',
  'bash',
  'csh',
  'dash',
  'eval',
  'fish',
  'hush',
  'ksh',
  'mksh',
  'msh',
  'sh',
  'source',
  'ssh',
  'su',
  'tcsh',
  'yash',
  'zsh',
]);

// Words with these characters may parse into more than themselves when run as shell code.
const shellSyntaxPattern = /[\s;&|()<>`'"\\$]/;

// Normalize common shell spellings such as `g\it c''ommit` before matching.
const unescapeShellWord = (command: string) =>
  command.replaceAll('\\\n', '').replaceAll(/\\(.)/gs, '$1').replaceAll(/''|""/g, '');

const commandName = (word: string) => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

// Matches `commit` and plumbing such as `commit-tree`, and also `commit-graph`: blocking wins.
// Substitutions may produce the subcommand, and alias values may define it. Environment-backed
// aliases fail closed because their values are unknown. Other option values are data here;
// scriptsOf reparses them to find commands that Git runs as shell code.
const isCommitWord = (word: string) => {
  const lowerWord = word.toLowerCase();

  if (/^--config-env=alias\.[^=]+=/.test(lowerWord)) {
    return true;
  }

  const isSubstitution = lowerWord.includes('$(') || lowerWord.includes('`');
  const isAlias = lowerWord.startsWith('alias.') && lowerWord.includes('=');
  const mayProduceCommit = isSubstitution || isAlias;
  const value = isAlias ? lowerWord.slice(lowerWord.indexOf('=') + 1) : lowerWord;
  const producesCommit = mayProduceCommit && /(?<![\w-])commit(?!\w)/.test(value);

  return /^commit(?:-|$)/.test(lowerWord) || producesCommit;
};

// Any word named `git` counts, so wrappers such as `env`, `sudo`, and `xargs` need no list, and
// options between `git` and `commit` are skipped. Alias definitions and substitutions can also
// supply a commit subcommand. Variable indirection (`c=commit; git $c`) still bypasses this.
const runsGitCommit = ({ words }: ShellCommand) => {
  const names = words.map(commandName);
  const gitIndex = names.indexOf('git');
  const laterWords = gitIndex === -1 ? [] : words.slice(gitIndex + 1);

  const optionWords = laterWords.map((word, index) =>
    laterWords[index - 1]?.toLowerCase() === '--config-env' ? `--config-env=${word}` : word,
  );

  return names.includes('git-commit') || optionWords.some(isCommitWord);
};

// Git runs some quoted arguments as shell code, as in `git rebase -x` and `git submodule foreach`.
const runsGit = ({ words }: ShellCommand) => words.some((word) => commandName(word) === 'git');

const scriptsOf = (commands: ShellCommand[]) =>
  commands.flatMap(({ words, heredocs }) => {
    const scripts = words.filter((word) => shellSyntaxPattern.test(word));

    for (const word of words) {
      const equalsIndex = word.indexOf('=');

      if (equalsIndex !== -1) {
        scripts.push(word.slice(equalsIndex + 1));
      }
    }

    return [...scripts, ...heredocs.map(({ body }) => body)];
  });

// Fail closed when nested scripts exceed the parser's inspection budget.
const maximumScriptDepth = 8;

const bytesPerKibibyte = 1024;
const bytesPerMebibyte = bytesPerKibibyte * bytesPerKibibyte;
const maximumScriptBytes = bytesPerMebibyte;

// 512 bytes hold a shebang and an executable header.
const maximumScriptHeaderBytes = 512;

// A wide script graph would otherwise stall the tool-call handler with synchronous reads.
const maximumScriptReads = 64;

// Interpreters that run the file named after them as shell code.
const shellInterpreters = new Set([
  '.',
  'ash',
  'bash',
  'csh',
  'dash',
  'fish',
  'hush',
  'ksh',
  'mksh',
  'msh',
  'sh',
  'source',
  'tcsh',
  'yash',
  'zsh',
]);

// Each wrapper's options that take a separate value word. Without skipping the value, it would
// look like the command word. A wrapper not in this table hides its command, and the guard then
// allows it.
const wrapperOptionValues = new Map<string, ReadonlySet<string>>([
  ['chrt', new Set(['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'])],
  ['command', new Set()],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-P', '--path'])],
  ['exec', new Set(['-a'])],
  ['flock', new Set(['-w', '--timeout', '-E', '--conflict-exit-code'])],
  ['ionice', new Set(['-c', '-n', '-p', '--class', '--classdata'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['setsid', new Set()],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  [
    'sudo',
    new Set([
      '-u',
      '--user',
      '-g',
      '--group',
      '-p',
      '--prompt',
      '-h',
      '--host',
      '-r',
      '--role',
      '-t',
      '--type',
      '-U',
      '--other-user',
      '-D',
      '--chdir',
      '-R',
      '--chroot',
      '-C',
      '--close-from',
      '-T',
      '--command-timeout',
    ]),
  ],
  ['taskset', new Set(['-c', '--cpu-list'])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['unbuffer', new Set()],
  [
    'xargs',
    new Set([
      '-a',
      '--arg-file',
      '-d',
      '--delimiter',
      '-E',
      '-I',
      '-J',
      '-L',
      '-n',
      '--max-args',
      '-P',
      '--max-procs',
      '-s',
      '--max-chars',
      '--process-slot-var',
      '-R',
      '-S',
      '--replace',
    ]),
  ],
]);

const wrapperPositionalSkips = new Map<string, PositionalSkip>([
  ['chrt', { count: 1, unless: new Set(['-p', '--pid']) }],
  ['flock', { count: 1, unless: new Set() }],
  ['taskset', { count: 1, unless: new Set(['-c', '--cpu-list']) }],
  ['timeout', { count: 1, unless: new Set() }],
]);

// A wrapper option whose value the wrapper runs as a shell command.
const wrapperCommandOptions = new Map<string, ReadonlySet<string>>([
  ['env', new Set(['-S', '--split-string'])],
  ['flock', new Set(['-c', '--command'])],
]);

const envSplitStringOptions = wrapperCommandOptions.get('env') ?? new Set<string>();

const optionValueNames = new Set(['-o', '+o', '-O', '--rcfile', '--init-file']);

// A `-` short-option word, split into its letters and the tail attached to them.
const shortOption = (word: string): ShortOption | undefined => {
  const match = /^-([A-Za-z]*)([\s\S]*)$/u.exec(word);

  return match === null ? undefined : { letters: match[1] ?? '', tail: match[2] ?? '' };
};

// A letter of an enabled short option; no `o` or `O` may precede it, because that letter then
// belongs to the option's value.
const enabledLetterIndex = (option: ShortOption, letter: string): number => {
  const index = option.letters.indexOf(letter);

  return index !== -1 && /[oO]/u.test(option.letters.slice(0, index)) ? -1 : index;
};

// An option with `c`, such as `-c` or `-lc`, puts the code in an argument, not in a file.
const isInlineCodeWord = (word: string): boolean => {
  const option = shortOption(word);

  return option !== undefined && enabledLetterIndex(option, 'c') !== -1;
};

// An option that makes the shell read its code from standard input; `+s` disables one instead.
const isStdinOptionWord = (word: string): boolean => {
  const option = shortOption(word);
  const namesStdin = option !== undefined && enabledLetterIndex(option, 's') !== -1;

  return word === '--stdin' || namesStdin;
};

const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const directorySyntaxPattern = /[$`'"]/u;

// Byte values read as latin1 that start a native executable, which the kernel runs itself.
const nativeMagics = [
  '\u007fELF',
  '\u00cf\u00fa\u00ed\u00fe',
  '\u00ce\u00fa\u00ed\u00fe',
  '\u00fe\u00ed\u00fa\u00cf',
  '\u00fe\u00ed\u00fa\u00ce',
  '\u00ca\u00fe\u00ba\u00be',
  'MZ',
];

// A long option matches exactly or with `=value`. A short option also matches with its value
// attached, as getopt reads `-command` as `-c` with the value `ommand`.
const matchesOption = (word: string, option: string) =>
  option.startsWith('--')
    ? word === option || word.startsWith(`${option}=`)
    : word.startsWith(option);

// In a short-option cluster such as `-Eu`, a value-taking letter takes the rest of the word or,
// when it is last, the next word.
const clusterValue = (
  words: readonly string[],
  index: number,
  word: string,
  options: ReadonlySet<string>,
): { value: string; next: number } | undefined => {
  if (!/^-[A-Za-z]{2,}$/u.test(word)) {
    return undefined;
  }

  const letters = word.slice(1);

  for (let position = 0; position < letters.length; position += 1) {
    const letter = letters[position] ?? '';

    if (!options.has(`-${letter}`)) {
      continue;
    }

    const attached = letters.slice(position + 1);

    if (attached !== '') {
      return { value: attached, next: index + 1 };
    }

    const value = words[index + 1];

    return value === undefined ? undefined : { value, next: index + 2 };
  }

  return undefined;
};

// getopt_long accepts any unambiguous abbreviation of a long option, so `--split` names
// `--split-string`.
const abbreviatedLongOption = (word: string, options: ReadonlySet<string>): string | undefined => {
  if (!word.startsWith('--') || word === '--') {
    return undefined;
  }

  const equals = word.indexOf('=');
  const name = equals === -1 ? word : word.slice(0, equals);

  const candidates = [...options].filter(
    (option) => option.startsWith('--') && option.startsWith(name),
  );

  return candidates.length === 1 ? candidates[0] : undefined;
};

// A value option takes the next word, an attached value, or a short-option cluster's value.
const optionValue = (
  words: readonly string[],
  index: number,
  options: ReadonlySet<string>,
): { value: string; next: number } | undefined => {
  const word = words[index] ?? '';

  for (const option of options) {
    if (!matchesOption(word, option)) {
      continue;
    }

    if (word === option) {
      const value = words[index + 1];

      return value === undefined ? undefined : { value, next: index + 2 };
    }

    const attached = word.slice(option.length);
    const value = attached.startsWith('=') ? attached.slice(1) : attached;

    return { value, next: index + 1 };
  }

  const abbreviated = abbreviatedLongOption(word, options);

  const equals = word.indexOf('=');

  if (abbreviated !== undefined && equals !== -1) {
    return { value: word.slice(equals + 1), next: index + 1 };
  }

  if (abbreviated !== undefined) {
    const value = words[index + 1];

    return value === undefined ? undefined : { value, next: index + 2 };
  }

  return clusterValue(words, index, word, options);
};

// A busybox applet is the program the wrapper runs, such as `sh` in `busybox sh`.
const appletWord = (
  words: readonly string[],
  index: number,
): { index: number; word: string } | undefined => {
  const word = words[index];

  if (word === undefined) {
    return undefined;
  }

  if (commandName(word) !== 'busybox') {
    return { index, word };
  }

  const applet = words[index + 1];

  return applet === undefined ? undefined : { index: index + 1, word: applet };
};

const appletInterpreter = (words: readonly string[]): string | undefined => {
  const applet = appletWord(words, 0);

  if (applet !== undefined) {
    return commandName(applet.word);
  }

  const [first] = words;

  return first === undefined ? undefined : commandName(first);
};

// The index of the program word among `env` arguments, skipping assignments and the value of every
// env option. An option value such as `FOO` in `-u FOO` is not the program.
const envProgramIndex = (words: readonly string[]): number => {
  const valueOptions = wrapperOptionValues.get('env') ?? new Set<string>();

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const value = optionValue(words, index, valueOptions);

    if (value !== undefined) {
      index = value.next - 1;

      continue;
    }

    if (word === '' || word.startsWith('-') || assignmentPattern.test(word)) {
      continue;
    }

    return index;
  }

  return -1;
};

// When `env` cannot split its value, the shell's word rules recover the words. Only a program word
// that needs the environment makes the value unreadable, so the caller can still allow a file whose
// program is a literal non-shell.
const splitStringWords = (value: string): EnvSplitWords | undefined => {
  const split = splitEnvString(value);

  if (split.kind === 'words') {
    return { kind: 'words', words: split.words };
  }

  const commands = parseShellCommands(value);
  const words = commands?.flatMap((command) => command.words);

  if (words === undefined) {
    return split.kind === 'unreadable' ? { kind: 'unreadable' } : undefined;
  }

  if (split.kind !== 'unreadable') {
    return { kind: 'words', words };
  }

  const programIndex = envProgramIndex(words);
  const program = programIndex === -1 ? undefined : appletWord(words, programIndex)?.word;

  return program?.includes('$') === true ? { kind: 'unreadable' } : { kind: 'words', words };
};

// `env` accepts assignments, options with values, and `-S`, whose value it splits into words,
// before the program. The split words are further env arguments, so they are read the same way.
const envTarget = (words: string[]): EnvSplitWords | undefined => {
  const valueOptions = wrapperOptionValues.get('env') ?? new Set<string>();
  const remaining = [...words];

  for (let index = 0; index < remaining.length; index += 1) {
    const word = remaining[index] ?? '';

    const split = optionValue(remaining, index, envSplitStringOptions);

    if (split !== undefined) {
      const value = [split.value, ...remaining.slice(split.next)].join(' ');
      const splitWords = splitStringWords(value);

      if (splitWords === undefined) {
        return undefined;
      }

      if (splitWords.kind === 'unreadable') {
        return splitWords;
      }

      remaining.splice(index, split.next - index, ...splitWords.words);
      index -= 1;

      continue;
    }

    const value = optionValue(remaining, index, valueOptions);

    if (value !== undefined) {
      index = value.next - 1;

      continue;
    }

    if (word === '' || word.startsWith('-') || assignmentPattern.test(word)) {
      continue;
    }

    return { kind: 'words', words: remaining.slice(index) };
  }

  return undefined;
};

const interpreterOf = (name: string | undefined): ShebangInterpreter =>
  name === undefined ? { kind: 'unnamed' } : { kind: 'named', name };

const shebangInterpreter = (text: string): ShebangInterpreter | undefined => {
  if (!text.startsWith('#!')) {
    return undefined;
  }

  const line = (text.slice(2).split('\n', 1)[0] ?? '').replace(/\r$/u, '');
  const words = line.trim().split(/\s+/u);
  const [program, ...rest] = words;

  if (program === undefined || program === '') {
    return undefined;
  }

  const name = commandName(program);

  if (name !== 'env') {
    return interpreterOf(appletInterpreter([program, ...rest]));
  }

  const target = envTarget(rest);

  if (target === undefined) {
    return { kind: 'unnamed' };
  }

  if (target.kind === 'unreadable') {
    return { kind: 'unreadable' };
  }

  return interpreterOf(appletInterpreter(target.words));
};

// The shebang runs the file as shell code when it names no program or a shell interpreter. An
// unreadable `env -S` value may name any program, so it also runs as shell code.
const runsAsShell = (shebang: ShebangInterpreter): boolean =>
  shebang.kind === 'unreadable' ||
  shebang.kind === 'unnamed' ||
  shellInterpreters.has(shebang.name);

const isShellScript = (text: string): boolean => {
  const shebang = shebangInterpreter(text);

  return shebang === undefined || runsAsShell(shebang);
};

const textVerdict = (text: string, checksShebang: boolean): NamedFileVerdict => {
  if (checksShebang) {
    const shebang = shebangInterpreter(text);

    if (shebang?.kind === 'unreadable') {
      return 'block';
    }

    const namesAnotherProgram = shebang !== undefined && !runsAsShell(shebang);

    if (namesAnotherProgram) {
      return 'allow';
    }
  }

  return text.includes('\u0000') ? 'block' : 'inspect';
};

// A missing or non-file path cannot run as a script, and a file the guard cannot read fails closed.
// A native binary runs in the kernel, so only a direct execution may allow it.
export const namedFileVerdict = (
  facts: NamedFileFacts,
  checksShebang: boolean,
): NamedFileVerdict => {
  if (facts.kind === 'missing') {
    return 'allow';
  }

  if (facts.kind === 'unreadable') {
    return 'block';
  }

  if (facts.kind === 'nativeBinary') {
    return checksShebang ? 'allow' : 'block';
  }

  if (facts.kind === 'oversize') {
    return checksShebang && !isShellScript(facts.head) ? 'allow' : 'block';
  }

  return textVerdict(facts.text, checksShebang);
};

const isOptionWord = (word: string) => word.startsWith('-') || word.startsWith('+');

const isMissingPathError = (error: unknown): boolean =>
  isMissingFile(error) || hasErrorCode(error, 'ENOTDIR');

const failedFacts = (error: unknown, failClosed: boolean): NamedFileFacts =>
  !failClosed || isMissingPathError(error) ? { kind: 'missing' } : { kind: 'unreadable' };

const readScriptHeader = (path: string): string => {
  const buffer = Buffer.alloc(maximumScriptHeaderBytes);
  const descriptor = openSync(path, 'r');

  try {
    const length = readSync(descriptor, buffer, 0, maximumScriptHeaderBytes, 0);

    return buffer.subarray(0, length).toString('latin1');
  } finally {
    closeSync(descriptor);
  }
};

const hasNativeHeader = (head: string) =>
  head.includes('\u0000') && nativeMagics.some((magic) => head.startsWith(magic));

const statPath = (path: string, failClosed: boolean): PathState => {
  try {
    return statSync(path).isFile() ? { kind: 'present' } : { kind: 'missing' };
  } catch (error) {
    return { kind: 'failed', facts: failedFacts(error, failClosed) };
  }
};

const readFileFacts = (path: string, failClosed: boolean): NamedFileFacts => {
  try {
    const head = readScriptHeader(path);

    if (hasNativeHeader(head)) {
      return { kind: 'nativeBinary' };
    }

    const text = readTextWithinSync(path, maximumScriptBytes);

    return text === undefined ? { kind: 'oversize', head } : { kind: 'text', text };
  } catch (error) {
    return failedFacts(error, failClosed);
  }
};

// A shell takes its code from the first operand after its options, so `-c --` and `-c -x` still
// name the code word.
const codeOperand = (words: string[], start: number): string | undefined => {
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (optionValueNames.has(word)) {
      index += 2;

      continue;
    }

    if (word === '--' || isOptionWord(word)) {
      index += 1;

      continue;
    }

    return word;
  }

  return undefined;
};

// A short-option word can carry its code after the `c`, as in `-c'git commit'`. A `c` after an
// `o` or `O` letter belongs to that option's value, as in `-onoclobber`.
const attachedInlineCode = (word: string): string | undefined => {
  const option = shortOption(word);

  if (option === undefined) {
    return undefined;
  }

  const index = enabledLetterIndex(option, 'c');

  if (index === -1) {
    return undefined;
  }

  const code = option.letters.slice(index + 1) + option.tail;

  return code === '' ? undefined : code;
};

const shellMode = (words: string[]): ShellMode => {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    const attached = attachedInlineCode(word);

    if (attached !== undefined) {
      return { kind: 'inline', code: attached };
    }

    if (isInlineCodeWord(word)) {
      return { kind: 'inline', code: codeOperand(words, index + 1) };
    }

    if (isStdinOptionWord(word)) {
      return { kind: 'stdin' };
    }

    if (optionValueNames.has(word)) {
      index += 1;
    } else if (!isOptionWord(word)) {
      return { kind: 'file', name: word };
    }
  }

  return { kind: 'stdin' };
};

const normalizeDescriptor = (descriptor: string | undefined): string =>
  String(Number(descriptor ?? '0'));

// Redirections apply in order, and `<&N` copies the target of descriptor N at that point.
const effectiveInput = (inputs: ShellInput[]): ShellInput | undefined => {
  const open = new Map<string, ShellInput>();
  let stdin: ShellInput | undefined;

  for (const input of inputs) {
    const descriptor = normalizeDescriptor(input.descriptor);
    const copied = input.kind === 'duplicate' ? open.get(normalizeDescriptor(input.target)) : input;
    const entry = copied === undefined ? undefined : { ...copied, descriptor: input.descriptor };

    if (entry === undefined) {
      continue;
    }

    open.set(descriptor, entry);

    if (descriptor === '0') {
      stdin = entry;
    }
  }

  return stdin;
};

const isInterpreter = (word: string) => shellInterpreters.has(commandName(word));

const takesOptionValue = (word: string, options: ReadonlySet<string>): boolean => {
  for (const option of options) {
    if (matchesOption(word, option)) {
      return true;
    }
  }

  return false;
};

const wrapperStep = (
  words: string[],
  index: number,
  name: string,
  valueOptions: ReadonlySet<string>,
  commandOptions: ReadonlySet<string>,
): WrapperStep => {
  const code = optionValue(words, index, commandOptions);

  if (code !== undefined) {
    // An `env -S` value that expands a variable to the program word cannot be read from the literal
    // words, so the caller must fail closed. The words after the value are further env arguments.
    const splitValue =
      name === 'env' ? [code.value, ...words.slice(code.next)].join(' ') : code.value;

    if (name === 'env' && splitStringWords(splitValue)?.kind === 'unreadable') {
      return { kind: 'unreadable' };
    }

    // `env -S` runs its split words together with the arguments that follow them.
    const trailing = name === 'env' ? words.slice(code.next).map(quoteShellArgument) : [];
    const text = [code.value, ...trailing].join(' ');

    return { kind: 'code', code: text, next: code.next };
  }

  const value = optionValue(words, index, valueOptions);

  if (value !== undefined) {
    return { kind: 'skip', next: value.next };
  }

  return isOptionWord(words[index] ?? '') ? { kind: 'skip', next: index + 1 } : { kind: 'command' };
};

const operandKind = (
  candidateCount: number,
  allowedPositionals: number,
  word: string,
): 'positional' | 'assignment' | 'command' => {
  // A positional slot wins over an assignment-shaped word: in `flock FOO=bar sh tool.sh` the
  // `FOO=bar` names the lock file, so `sh` is the command word.
  if (candidateCount <= allowedPositionals) {
    return 'positional';
  }

  return assignmentPattern.test(word) ? 'assignment' : 'command';
};

const wrapperStepWord = (step: WrapperStep): WrapperWord | undefined => {
  if (step.kind === 'code') {
    return { kind: 'code', next: step.next, code: step.code };
  }

  if (step.kind === 'unreadable') {
    return { kind: 'unreadable' };
  }

  return undefined;
};

const wrapperWord = (
  words: string[],
  index: number,
  name: string,
  progress: WrapperProgress,
): WrapperWord => {
  const valueOptions = wrapperOptionValues.get(name) ?? new Set<string>();
  const commandOptions = wrapperCommandOptions.get(name) ?? new Set<string>();
  const skip = wrapperPositionalSkips.get(name);
  const word = words[index] ?? '';
  const skipped = skip === undefined ? 0 : skip.count;

  if (skip !== undefined && takesOptionValue(word, skip.unless)) {
    progress.sawUnless = true;
  }

  const step = wrapperStep(words, index, name, valueOptions, commandOptions);
  const stepWord = wrapperStepWord(step);

  if (stepWord !== undefined) {
    return stepWord;
  }

  if (step.kind === 'skip') {
    return { kind: 'skip', next: step.next };
  }

  const allowed = progress.sawUnless ? 0 : skipped;
  const kind = operandKind(progress.positionals + 1, allowed, word);

  if (kind === 'command') {
    return { kind };
  }

  if (kind === 'assignment') {
    return { kind, word };
  }

  return { kind };
};

// A wrapper permutes its own options around its positional arguments, so one walk finds both the
// shell code it runs and the wrapped command word.
const scanWrapper = (words: string[], index: number, name: string): WrapperScan => {
  const assignments: string[] = [];
  const codes: string[] = [];
  const progress: WrapperProgress = { positionals: 0, sawUnless: false };
  let next = index + 1;

  while (next < words.length) {
    const classified = wrapperWord(words, next, name, progress);

    if (classified.kind === 'command') {
      return { kind: 'command', assignments, codes, commandIndex: next };
    }

    if (classified.kind === 'unreadable') {
      return { kind: 'unreadable', assignments, codes };
    }

    if (classified.kind === 'code') {
      codes.push(classified.code);
      next = classified.next;

      continue;
    }

    if (classified.kind === 'skip') {
      next = classified.next;

      continue;
    }

    if (classified.kind === 'assignment') {
      assignments.push(classified.word);
    } else {
      progress.positionals += 1;
    }

    next += 1;
  }

  return { kind: 'command', assignments, codes, commandIndex: undefined };
};

// Shell keywords that can precede a command word in the same simple command.
const reservedWords = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);

const leadingWordCount = (words: string[]): number => {
  let index = 0;

  while (index < words.length && reservedWords.has(words[index] ?? '')) {
    index += 1;
  }

  return index;
};

const walkWrappers = (words: string[]): WrapperScan => {
  const assignments: string[] = [];
  let index = leadingWordCount(words);

  while (index < words.length) {
    const word = words[index] ?? '';

    if (assignmentPattern.test(word)) {
      assignments.push(word);
      index += 1;

      continue;
    }

    const name = commandName(word);

    if (wrapperOptionValues.get(name) === undefined) {
      return {
        kind: 'command',
        assignments,
        codes: [],
        commandIndex: isOptionWord(word) ? undefined : index,
      };
    }

    const scan = scanWrapper(words, index, name);

    assignments.push(...scan.assignments);

    if (scan.kind === 'unreadable') {
      return { kind: 'unreadable', assignments, codes: scan.codes };
    }

    if (scan.codes.length > 0) {
      return { kind: 'command', assignments, codes: scan.codes, commandIndex: undefined };
    }

    if (scan.commandIndex === undefined) {
      return { kind: 'command', assignments, codes: [], commandIndex: undefined };
    }

    index = scan.commandIndex;
  }

  return { kind: 'command', assignments, codes: [], commandIndex: undefined };
};

const commandWordIndex = (words: string[]): number | undefined => {
  const scan = walkWrappers(words);

  return scan.kind === 'command' ? scan.commandIndex : undefined;
};

const commandWord = ({ arguments: words }: ShellCommand): string | undefined => {
  const index = commandWordIndex(words);

  return index === undefined ? undefined : words[index];
};

// Options whose next word `find` runs as a command.
const findExecOptions = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const isShellRunner = (word: string | undefined): boolean =>
  word !== undefined && shellRunnerNames.has(commandName(word));

// A shell runs the source only in executable position, after a busybox applet, or after a `find`
// exec option, so `git add scripts/bash` is data.
const runsShell = (command: ShellCommand) => {
  const index = commandWordIndex(command.arguments);
  const shell = index === undefined ? undefined : appletWord(command.arguments, index);

  if (shell !== undefined && isShellRunner(shell.word)) {
    return true;
  }

  if (shell === undefined || commandName(shell.word) !== 'find') {
    return false;
  }

  return command.arguments.some(
    (word, wordIndex) =>
      findExecOptions.has(word) && isShellRunner(command.arguments[wordIndex + 1]),
  );
};

// A `.` or `source` operand resolves through PATH before the working directory.
const searchesPathFirst = (word: string): boolean => {
  const name = commandName(word);

  return name === '.' || name === 'source';
};

// An interpreter runs a file or inline code only from the executable position, so data such as
// `printf sh commit.sh` names no script.
const interpreterSources = (command: ShellCommand): InterpreterSources => {
  const scan = walkWrappers(command.arguments);

  if (scan.kind === 'unreadable') {
    return { kind: 'unreadable' };
  }

  const { codes, commandIndex } = scan;

  if (codes.length > 0) {
    return { kind: 'sources', files: [], code: codes };
  }

  if (commandIndex === undefined) {
    return { kind: 'sources', files: [], code: [] };
  }

  const shell = appletWord(command.arguments, commandIndex);

  if (shell === undefined || !isInterpreter(shell.word)) {
    return { kind: 'sources', files: [], code: [] };
  }

  const mode = shellMode(command.arguments.slice(shell.index + 1));
  const stdin = effectiveInput(command.inputs);

  if (mode.kind === 'file') {
    return {
      kind: 'sources',
      files: [mode.name],
      code: [],
      pathFirst: searchesPathFirst(shell.word),
    };
  }

  if (mode.kind === 'inline') {
    return { kind: 'sources', files: [], code: mode.code === undefined ? [] : [mode.code] };
  }

  if (stdin === undefined || stdin.kind === 'heredoc') {
    return { kind: 'sources', files: [], code: [] };
  }

  if (stdin.kind === 'hereString') {
    return { kind: 'sources', files: [], code: [stdin.target] };
  }

  return { kind: 'sources', files: [stdin.target], code: [] };
};

// A bare word resolves through `PATH`, so only a word with a path separator names a local file.
const directScriptName = (command: ShellCommand): string | undefined => {
  const word = commandWord(command);

  if (word === undefined || !word.includes('/')) {
    return undefined;
  }

  return word;
};

const isPlainDirectoryWord = (word: string) =>
  !isOptionWord(word) && !directorySyntaxPattern.test(word);

const isAssignmentWord = (word: string): boolean => assignmentPattern.test(word);

// HOME names a directory only when it is non-empty.
const homeDirectory = (): string | undefined => {
  const home = gitEnvironment().HOME;

  if (home === undefined) {
    return homedir();
  }

  return home === '' ? undefined : home;
};

// Bash accepts these options in any order and in clusters, and ignores `-e` unless `-P` is in
// effect at the end, so every matching word is an option.
const cdOptionPattern = /^-[LPe@]+$/u;

// Options end at the first operand, so `cd sub -P` names two operands. An option `cd` rejects is an
// operand, so it keeps the current directory.
const directoryOperands = (words: string[]): string[] => {
  const operands: string[] = [];
  let optionsEnded = false;

  for (const word of words) {
    if (!optionsEnded && word === '--') {
      optionsEnded = true;

      continue;
    }

    if (!optionsEnded && cdOptionPattern.test(word)) {
      continue;
    }

    optionsEnded = true;
    operands.push(word);
  }

  return operands;
};

// A target moves the shell only when it names a directory.
const directoryTarget = (target: string, directory: string): string => {
  try {
    return statSync(target).isDirectory() ? target : directory;
  } catch {
    return directory;
  }
};

// Only a literal `cd` changes the directory of the commands after it in the same list. Leading
// options and assignment words do not change which directory it names.
const nextDirectory = (command: ShellCommand, directory: string): string => {
  const words = command.arguments.slice(leadingWordCount(command.arguments));
  const nameIndex = words.findIndex((word) => !isAssignmentWord(word));
  const name = nameIndex === -1 ? undefined : words[nameIndex];

  if (name === undefined || commandName(name) !== 'cd') {
    return directory;
  }

  const operands = directoryOperands(words.slice(nameIndex + 1));

  // A bare `cd` goes HOME; `cd -` goes to an OLDPWD the guard cannot know, so it stays.
  if (operands.length === 0) {
    const home = homeDirectory();

    return home === undefined ? directory : directoryTarget(resolve(directory, home), directory);
  }

  // The shell rejects a second operand and stays where it is, so only one operand moves it.
  if (operands.length !== 1) {
    return directory;
  }

  const [operand] = operands;

  if (operand === undefined || !isPlainDirectoryWord(operand)) {
    return directory;
  }

  return directoryTarget(resolve(directory, operand), directory);
};

const isExpandablePathEntry = (entry: string): boolean =>
  !directorySyntaxPattern.test(entry) && !entry.startsWith('~');

const pathAssignmentIn = (words: string[]): string | undefined => {
  let assigned: string | undefined;

  for (const word of words) {
    if (!isAssignmentWord(word)) {
      continue;
    }

    const equalsIndex = word.indexOf('=');

    if (word.slice(0, equalsIndex) === 'PATH') {
      assigned = word.slice(equalsIndex + 1);
    }
  }

  return assigned;
};

// A `PATH=` assignment the shell applies before the command, including one an `env` passes on.
const commandPathAssignment = (command: ShellCommand): string | undefined =>
  pathAssignmentIn(walkWrappers(command.arguments).assignments);

const namedScriptsOf = (
  command: ShellCommand,
  directory: string,
  pathDirectories: string[],
  sources: Extract<InterpreterSources, { kind: 'sources' }>,
): NamedScript[] => {
  const pathFirst = sources.pathFirst ?? false;

  const scripts = sources.files.map((name) => ({
    name,
    checksShebang: false,
    cwd: directory,
    pathDirectories,
    pathFirst,
  }));

  const directName = directScriptName(command);

  if (directName !== undefined) {
    scripts.push({
      name: directName,
      checksShebang: true,
      cwd: directory,
      pathDirectories,
      pathFirst: false,
    });
  }

  return scripts;
};

const factsKey = (path: string, failClosed: boolean): string =>
  `${failClosed ? 'closed' : 'open'}:${path}`;

const scriptFacts = (path: string, state: GuardState, failClosed: boolean): NamedFileFacts => {
  const key = factsKey(path, failClosed);
  const cached = state.facts.get(key);

  if (cached !== undefined) {
    return cached;
  }

  // A stat is not a read, so a path that does not exist costs no budget.
  const stat = statPath(path, failClosed);

  if (stat.kind !== 'present') {
    const facts: NamedFileFacts = stat.kind === 'missing' ? { kind: 'missing' } : stat.facts;

    state.facts.set(key, facts);

    return facts;
  }

  // Reaching the cap fails closed without reading an existing file.
  if (state.reads >= maximumScriptReads) {
    const capped: NamedFileFacts = { kind: 'unreadable' };

    state.facts.set(key, capped);

    return capped;
  }

  const facts = readFileFacts(path, failClosed);

  // A native binary is not parsed, so only a script costs budget.
  if (facts.kind !== 'nativeBinary') {
    state.reads += 1;
  }

  state.facts.set(key, facts);

  return facts;
};

// A shell looks up a bare interpreter operand through PATH when the local file is missing.
// A leading `~` or `~/` names a path under HOME, as the shell expands it.
const expandHome = (name: string, directory: string): string | undefined => {
  if (name !== '~' && !name.startsWith('~/')) {
    return undefined;
  }

  const home = homeDirectory();

  return home === undefined ? undefined : join(resolve(directory, home), name.slice(1));
};

const candidatePaths = ({
  name,
  checksShebang,
  cwd,
  pathDirectories,
  pathFirst,
}: NamedScript): string[] => {
  const home = expandHome(name, cwd);

  if (home !== undefined) {
    return [home];
  }

  const local = resolve(cwd, name);

  if (checksShebang || name.includes('/')) {
    return [local];
  }

  const searched = pathDirectories.map((directory) => resolve(cwd, directory, name));

  return pathFirst ? [...searched, local] : [local, ...searched];
};

const inspectNamedScript = (
  script: NamedScript,
  state: GuardState,
  inspect: (text: string) => boolean,
): boolean => {
  for (const [index, path] of candidatePaths(script).entries()) {
    const facts = scriptFacts(path, state, index === 0);

    if (facts.kind === 'missing') {
      continue;
    }

    const verdict = namedFileVerdict(facts, script.checksShebang);

    if (verdict === 'block') {
      return true;
    }

    if (verdict === 'inspect' && facts.kind === 'text') {
      return inspect(facts.text);
    }

    return false;
  }

  return false;
};

// A command at a depth resolves against that depth's directory; a shallower command discards the
// deeper entries a subshell left behind.
const directoryFor = (directories: string[], depth: number): string => {
  while (directories.length <= depth) {
    directories.push(directories[directories.length - 1] ?? '');
  }

  directories.length = depth + 1;

  return directories[depth] ?? '';
};

const parentScope = (scope: string): string =>
  scope.includes('.') ? scope.slice(0, scope.lastIndexOf('.')) : '';

// A substitution's scope can be nested under a scope that owns no command, such as a heredoc
// body, so walk up until a scope with a stack exists.
const ancestorDirectory = (stacks: Map<string, string[]>, scope: string): string | undefined => {
  let current = scope;

  while (current !== '') {
    current = parentScope(current);
    const stack = stacks.get(current);

    if (stack !== undefined) {
      return stack[stack.length - 1];
    }
  }

  return undefined;
};

// A heredoc body expands before its owner runs, so it resolves against the directory its owner
// started in, not the one the owner's own `cd` moves to.
const recordedBase = (bases: Map<string, string>, scope: string): string | undefined => {
  let current = scope;

  while (current !== '') {
    const base = bases.get(current);

    if (base !== undefined) {
      return base;
    }

    current = parentScope(current);
  }

  return undefined;
};

// Each scope starts where its owner command started.
const directoryStack = (
  stacks: Map<string, string[]>,
  scope: string,
  cwd: string,
  bases: Map<string, string>,
): string[] => {
  const existing = stacks.get(scope);

  if (existing !== undefined) {
    return existing;
  }

  const base = recordedBase(bases, scope) ?? ancestorDirectory(stacks, scope) ?? cwd;
  const stack = [base];

  stacks.set(scope, stack);

  return stack;
};

const pathDirectoriesFor = (
  assigned: string | undefined,
  directory: string,
  state: GuardState,
  inherited: string[] | undefined,
): string[] => {
  if (assigned === undefined) {
    return inherited ?? state.pathDirectories;
  }

  const entries = assigned.split(delimiter).filter((entry) => entry !== '');
  const expandable = entries.filter((entry) => isExpandablePathEntry(entry));
  const resolved = expandable.map((entry) => resolve(directory, entry));
  const base = inherited ?? state.pathDirectories;

  return expandable.length === entries.length ? resolved : [...resolved, ...base];
};

const readPathDirectories = (): string[] => {
  const path = gitEnvironment().PATH ?? '';

  return path.split(delimiter).filter((directory) => directory !== '');
};

const recordHeredocBases = (
  command: ShellCommand,
  directory: string,
  bases: Map<string, string>,
): void => {
  for (const { scope } of command.heredocs) {
    if (scope !== undefined) {
      bases.set(scope, directory);
    }
  }
};

const createsCommit = (
  source: string,
  cwd: string,
  state: GuardState,
  depth = 0,
  inheritedPath?: string[],
): boolean => {
  if (depth > maximumScriptDepth) {
    return true;
  }

  const commands = parseShellCommands(source);

  if (commands === undefined) {
    return gitCommitPattern.test(unescapeShellWord(source));
  }

  if (commands.some(runsGitCommit)) {
    return true;
  }

  const inspect = (directory: string, text: string, pathDirectories: string[]) =>
    createsCommit(text, directory, state, depth + 1, pathDirectories);

  const scriptCommands = commands.some(runsShell) ? commands : commands.filter(runsGit);
  const stacks = new Map<string, string[]>();
  const bases = new Map<string, string>();

  for (const command of commands) {
    const stack = directoryStack(stacks, command.scope, cwd, bases);
    const directory = directoryFor(stack, command.depth);
    const sources = interpreterSources(command);

    if (sources.kind === 'unreadable') {
      return true;
    }

    const pathDirectories = pathDirectoriesFor(
      commandPathAssignment(command),
      directory,
      state,
      inheritedPath,
    );

    const scripts = namedScriptsOf(command, directory, pathDirectories, sources);

    recordHeredocBases(command, directory, bases);

    const blocks = (script: NamedScript) =>
      inspectNamedScript(script, state, (text) =>
        inspect(script.cwd, text, script.pathDirectories),
      );

    if (scripts.some(blocks)) {
      return true;
    }

    const inline = sources.code;

    if (inline.length > 0 || scriptCommands.includes(command)) {
      const texts = [...scriptsOf([command]), ...inline];

      if (texts.some((text) => text !== source && inspect(directory, text, pathDirectories))) {
        return true;
      }
    }

    stack[command.depth] = nextDirectory(command, directory);
  }

  return false;
};

export const guardToolCall = (
  event: ToolCallEvent,
  context: Pick<ExtensionContext, 'cwd'>,
): ToolCallEventResult | undefined => {
  if (!isToolCallEventType('bash', event)) {
    return undefined;
  }

  const state: GuardState = {
    facts: new Map(),
    reads: 0,
    pathDirectories: readPathDirectories(),
  };

  if (createsCommit(event.input.command, context.cwd, state)) {
    return { block: true, reason: commitGuardReason };
  }

  return undefined;
};
