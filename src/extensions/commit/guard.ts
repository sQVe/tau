import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { readTextWithinSync } from '../../record.js';
import { parseShellCommands } from '../../shell.js';
import type { ShellCommand, ShellInput } from '../../shell.js';

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

interface InterpreterSources {
  files: string[];
  code: string[];
}

// A wrapper positional word before the command word, skipped unless one of its options is present.
interface PositionalSkip {
  count: number;
  unless: ReadonlySet<string>;
}

interface WrapperScan {
  // The shell code of every command option seen, in source order.
  codes: string[];
  // Where the wrapped command word starts, when a command follows.
  commandIndex: number | undefined;
}

type WrapperStep =
  | { kind: 'code'; code: string; next: number }
  | { kind: 'skip'; next: number }
  | { kind: 'command' };

export const commitGuardReason =
  'Blocked git commit via bash. Use the `commit` tool instead. To amend the last commit when it is not a merge or root commit, run `git reset --soft HEAD~1`, then call `commit` with the files of both changes. To fix up an older commit, call `commit` with the `fixup` field (kind `fixup`, `squash`, or `amend`) for the fix, then run `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash <base>`.';

// Used only when the command does not parse. It matches `commit` anywhere after `git` in a
// statement, so it blocks mentions in quoted text too.
const gitCommitPattern = /\bgit\b[^;|&\n]*(?<![\w/-])commit(?![\w/])|\bgit-commit\b/i;

// Commands that may run a string or standard input as shell code. When one appears anywhere in the
// source, every word and heredoc body in that source is parsed as a script too, because piped data
// such as `echo 'git commit' | sh` becomes code.
const shellRunnerNames = new Set([
  'ash',
  'bash',
  'dash',
  'eval',
  'ksh',
  'mksh',
  'sh',
  'ssh',
  'su',
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

const runsShell = ({ words }: ShellCommand) =>
  words.some((word) => shellRunnerNames.has(commandName(word)));

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

// oxlint-disable-next-line no-magic-numbers -- A 1 MiB script cap bounds the read of one file.
const maximumScriptBytes = 1024 * 1024;

// 512 bytes hold a shebang and an executable header.
const maximumScriptHeaderBytes = 512;

// A wide script graph would otherwise stall the tool-call handler with synchronous reads.
const maximumScriptReads = 64;

// Interpreters that run the file named after them as shell code.
const shellInterpreters = new Set([
  '.',
  'ash',
  'bash',
  'dash',
  'ksh',
  'mksh',
  'sh',
  'source',
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
      '-e',
      '-I',
      '-i',
      '-J',
      '-L',
      '-l',
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
  ['flock', new Set(['-c', '--command'])],
]);

const optionValueNames = new Set(['-o', '+o', '-O', '--rcfile', '--init-file']);

// An option with `c`, such as `-c` or `-lc`, puts the code in an argument, not in a file.
const inlineCodePattern = /^[-+][A-Za-z]*c[A-Za-z]*$/u;

// An option that makes the shell read its code from standard input.
const stdinOptionPattern = /^(?:--stdin|-[A-Za-z]*s[A-Za-z]*)$/u;

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

// `env` accepts assignments and `-S`, whose value it splits into words, before the program.
const envTarget = (words: string[]): string | undefined => {
  const expanded: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (word === '-S' || word === '--split-string') {
      expanded.push(...(words[index + 1] ?? '').split(/\s+/u));
      index += 1;
    } else {
      expanded.push(word);
    }
  }

  return expanded.find(
    (word) => word !== '' && !word.startsWith('-') && !assignmentPattern.test(word),
  );
};

const shebangInterpreter = (text: string): string | undefined => {
  if (!text.startsWith('#!')) {
    return undefined;
  }

  const line = (text.slice(2).split('\n', 1)[0] ?? '').replace(/\r$/u, '');
  const words = line.trim().split(/\s+/u);
  const [program, ...rest] = words;

  if (program === undefined || program === '') {
    return undefined;
  }

  if (commandName(program) !== 'env') {
    return commandName(program);
  }

  const target = envTarget(rest);

  return target === undefined ? undefined : commandName(target);
};

const isShellScript = (text: string): boolean => {
  const interpreter = shebangInterpreter(text);

  return interpreter === undefined || shellInterpreters.has(interpreter);
};

const textVerdict = (text: string, checksShebang: boolean): NamedFileVerdict => {
  if (checksShebang && !isShellScript(text)) {
    return 'allow';
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
  !head.startsWith('#!') &&
  head.includes('\u0000') &&
  nativeMagics.some((magic) => head.startsWith(magic));

const namedFileFacts = (path: string, failClosed: boolean): NamedFileFacts => {
  try {
    if (!statSync(path).isFile()) {
      return { kind: 'missing' };
    }
  } catch (error) {
    return failedFacts(error, failClosed);
  }

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

const shellMode = (words: string[]): ShellMode => {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (inlineCodePattern.test(word)) {
      return { kind: 'inline', code: words[index + 1] };
    }

    if (stdinOptionPattern.test(word)) {
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

// A long option matches exactly or with `=value`. A short option also matches with its value
// attached, as getopt reads `-command` as `-c` with the value `ommand`.
const matchesOption = (word: string, option: string) =>
  option.startsWith('--')
    ? word === option || word.startsWith(`${option}=`)
    : word.startsWith(option);

const optionValue = (
  words: string[],
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

  return undefined;
};

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
  valueOptions: ReadonlySet<string>,
  commandOptions: ReadonlySet<string>,
): WrapperStep => {
  const code = optionValue(words, index, commandOptions);

  if (code !== undefined) {
    return { kind: 'code', code: code.value, next: code.next };
  }

  const value = optionValue(words, index, valueOptions);

  if (value !== undefined) {
    return { kind: 'skip', next: value.next };
  }

  return isOptionWord(words[index] ?? '') ? { kind: 'skip', next: index + 1 } : { kind: 'command' };
};

// A wrapper permutes its own options around its positional arguments, so one walk finds both the
// shell code it runs and the wrapped command word.
const scanWrapper = (words: string[], index: number, name: string): WrapperScan => {
  const valueOptions = wrapperOptionValues.get(name) ?? new Set<string>();
  const commandOptions = wrapperCommandOptions.get(name) ?? new Set<string>();
  const skip = wrapperPositionalSkips.get(name);
  const codes: string[] = [];
  const skipped = skip === undefined ? 0 : skip.count;
  let positionals = 0;
  let sawUnless = false;
  let next = index + 1;

  while (next < words.length) {
    const word = words[next] ?? '';

    sawUnless ||= skip !== undefined && takesOptionValue(word, skip.unless);

    const step = wrapperStep(words, next, valueOptions, commandOptions);

    if (step.kind === 'code') {
      codes.push(step.code);
      next = step.next;

      continue;
    }

    if (step.kind === 'skip') {
      next = step.next;

      continue;
    }

    positionals += 1;

    if (positionals > (sawUnless ? 0 : skipped)) {
      return { codes, commandIndex: next };
    }

    next += 1;
  }

  return { codes, commandIndex: undefined };
};

const walkWrappers = (words: string[]): WrapperScan => {
  let index = 0;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (assignmentPattern.test(word)) {
      index += 1;

      continue;
    }

    const name = commandName(word);

    if (wrapperOptionValues.get(name) === undefined) {
      return { codes: [], commandIndex: isOptionWord(word) ? undefined : index };
    }

    const scan = scanWrapper(words, index, name);

    if (scan.codes.length > 0) {
      return { codes: scan.codes, commandIndex: undefined };
    }

    if (scan.commandIndex === undefined) {
      return { codes: [], commandIndex: undefined };
    }

    index = scan.commandIndex;
  }

  return { codes: [], commandIndex: undefined };
};

const commandWordIndex = (words: string[]): number | undefined => walkWrappers(words).commandIndex;

const commandWord = ({ arguments: words }: ShellCommand): string | undefined => {
  const index = commandWordIndex(words);

  return index === undefined ? undefined : words[index];
};

// An interpreter runs a file or inline code only from the executable position, so data such as
// `printf sh commit.sh` names no script.
const interpreterSources = (command: ShellCommand): InterpreterSources => {
  const { codes, commandIndex } = walkWrappers(command.arguments);

  if (codes.length > 0) {
    return { files: [], code: codes };
  }

  if (commandIndex === undefined) {
    return { files: [], code: [] };
  }

  const word = command.arguments[commandIndex];

  if (word === undefined || !isInterpreter(word)) {
    return { files: [], code: [] };
  }

  const mode = shellMode(command.arguments.slice(commandIndex + 1));
  const stdin = effectiveInput(command.inputs);

  if (mode.kind === 'file') {
    return { files: [mode.name], code: [] };
  }

  if (mode.kind === 'inline') {
    return { files: [], code: mode.code === undefined ? [] : [mode.code] };
  }

  if (stdin === undefined || stdin.kind === 'heredoc') {
    return { files: [], code: [] };
  }

  if (stdin.kind === 'hereString') {
    return { files: [], code: [stdin.target] };
  }

  return { files: [stdin.target], code: [] };
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

// Only a literal `cd` changes the directory of the commands after it in the same list.
const nextDirectory = (command: ShellCommand, directory: string): string => {
  const { arguments: words } = command;
  const [name, operand] = words;

  if (words.length !== 2 || name === undefined || operand === undefined) {
    return directory;
  }

  if (commandName(name) !== 'cd' || !isPlainDirectoryWord(operand)) {
    return directory;
  }

  const target = resolve(directory, operand);

  try {
    return statSync(target).isDirectory() ? target : directory;
  } catch {
    return directory;
  }
};

const namedScriptsOf = (command: ShellCommand, directory: string): NamedScript[] => {
  const scripts = interpreterSources(command).files.map((name) => ({
    name,
    checksShebang: false,
    cwd: directory,
  }));

  const directName = directScriptName(command);

  if (directName !== undefined) {
    scripts.push({ name: directName, checksShebang: true, cwd: directory });
  }

  return scripts;
};

const factsKey = (path: string, failClosed: boolean): string =>
  `${failClosed ? 'closed' : 'open'}:${path}`;

const scriptFacts = (
  path: string,
  state: GuardState,
  failClosed: boolean,
): NamedFileFacts | undefined => {
  const key = factsKey(path, failClosed);
  const cached = state.facts.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const facts = namedFileFacts(path, failClosed);

  // Only a candidate that exists is read; a probe that finds nothing costs one stat and no budget.
  if (facts.kind !== 'missing') {
    state.reads += 1;

    if (state.reads > maximumScriptReads) {
      return undefined;
    }
  }

  state.facts.set(key, facts);

  return facts;
};

// A shell looks up a bare interpreter operand through PATH when the local file is missing.
const candidatePaths = ({ name, checksShebang, cwd }: NamedScript, state: GuardState): string[] => {
  const local = resolve(cwd, name);

  if (checksShebang || name.includes('/')) {
    return [local];
  }

  return [local, ...state.pathDirectories.map((directory) => resolve(directory, name))];
};

const inspectNamedScript = (
  script: NamedScript,
  state: GuardState,
  inspect: (text: string) => boolean,
): boolean => {
  for (const [index, path] of candidatePaths(script, state).entries()) {
    const facts = scriptFacts(path, state, index === 0);

    if (facts === undefined) {
      return true;
    }

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

const readPathDirectories = (): string[] => {
  // oxlint-disable-next-line node/no-process-env -- The shell searches the PATH of the running process.
  const path = process.env['PATH'] ?? '';

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

const createsCommit = (source: string, cwd: string, state: GuardState, depth = 0): boolean => {
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

  const inspect = (directory: string, text: string) =>
    createsCommit(text, directory, state, depth + 1);

  const scriptCommands = commands.some(runsShell) ? commands : commands.filter(runsGit);
  const stacks = new Map<string, string[]>();
  const bases = new Map<string, string>();

  for (const command of commands) {
    const stack = directoryStack(stacks, command.scope, cwd, bases);
    const directory = directoryFor(stack, command.depth);
    const scripts = namedScriptsOf(command, directory);

    recordHeredocBases(command, directory, bases);

    const blocks = (script: NamedScript) =>
      inspectNamedScript(script, state, (text) => inspect(script.cwd, text));

    if (scripts.some(blocks)) {
      return true;
    }

    const inline = interpreterSources(command).code;

    if (inline.length > 0 || scriptCommands.includes(command)) {
      const sources = [...scriptsOf([command]), ...inline];

      if (sources.some((text) => text !== source && inspect(directory, text))) {
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
