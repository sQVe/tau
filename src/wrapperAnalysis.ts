// Reads the command a shell word list runs, past its leading keywords, assignments, and wrappers.
// The tokenizer stays in shell.ts; this module owns only the wrapper tables and the command head.

export interface CommandWords {
  readonly words: readonly string[];
  readonly lookup: boolean;
  // True when an `env -S` value depends on the environment, so no command can be named.
  readonly unreadable: boolean;
}

export interface CommandStart {
  // The index of the word the shell runs as the command, or the word count when none follows.
  readonly index: number;
  readonly wrappers: readonly { readonly name: string; readonly index: number }[];
  readonly lookup: boolean;
}

// `env` splits the value of `-S`/`--split-string` with its own word rules, not the shell's: it
// honours single and double quotes and a fixed escape set. A `${VAR}` expansion depends on the
// environment, so the words cannot be known here and the caller must fail closed.
export type EnvSplitString =
  | { readonly kind: 'words'; readonly words: readonly string[] }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'ignored' };

type EnvEscape =
  | { readonly kind: 'character'; readonly value: string; readonly end: number }
  | { readonly kind: 'separator'; readonly end: number }
  | { readonly kind: 'stop' }
  | { readonly kind: 'invalid' };

type EnvSplit =
  | { readonly kind: 'split'; readonly words: readonly string[]; readonly end: number }
  | { readonly kind: 'unreadable' };

// A word an `env -S` value expands to, or the words before an `env` whose value cannot be resolved.
export interface ExpandedWords {
  readonly words: readonly string[];
  // True when an `env -S` value depends on the environment, so the caller cannot know what runs.
  readonly unreadable: boolean;
}

interface EnvSplitState {
  readonly words: string[];
  word: string;
  started: boolean;
  index: number;
  quote: 'single' | 'double' | undefined;
}

// The name a word runs, without its directory.
export const commandNameOf = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

// A word that runs the command after it instead of being the command itself.
const commandKeywords: ReadonlySet<string> = new Set([
  '!',
  '{',
  'do',
  'elif',
  'else',
  'if',
  'then',
  'until',
  'while',
]);

// Each wrapper runs the command after its own options and fixed arguments. The set lists the
// options that take the next word as their value.
export const wrapperValueOptions: Readonly<Record<string, ReadonlySet<string>>> = {
  chroot: new Set(['--groups', '--userspec']),
  chrt: new Set(['-D', '-P', '-T', '--sched-deadline', '--sched-period', '--sched-runtime']),
  command: new Set(),
  doas: new Set(['-C', '-a', '-u']),
  env: new Set(['-C', '-P', '-S', '-u', '--chdir', '--path', '--split-string', '--unset']),
  exec: new Set(['-a']),
  flock: new Set(['-E', '-c', '-w', '--command', '--conflict-exit-code', '--timeout']),
  ionice: new Set([
    '-P',
    '-c',
    '-n',
    '-p',
    '-u',
    '--class',
    '--classdata',
    '--pgid',
    '--pid',
    '--uid',
  ]),
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set(),
  setsid: new Set(),
  stdbuf: new Set(['-e', '-i', '-o', '--error', '--input', '--output']),
  taskset: new Set(['-c', '--cpu-list']),
  sudo: new Set([
    '-C',
    '-D',
    '-R',
    '-T',
    '-U',
    '-a',
    '-c',
    '-g',
    '-h',
    '-p',
    '-r',
    '-t',
    '-u',
    '--auth-type',
    '--chdir',
    '--chroot',
    '--close-from',
    '--command-timeout',
    '--group',
    '--host',
    '--login-class',
    '--other-user',
    '--prompt',
    '--role',
    '--type',
    '--user',
  ]),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  unbuffer: new Set(),
  watch: new Set(['-n', '-q', '--equexit', '--interval']),
  xargs: new Set([
    '-E',
    '-I',
    '-J',
    '-L',
    '-P',
    '-R',
    '-S',
    '-a',
    '-d',
    '-n',
    '-s',
    '--arg-file',
    '--delimiter',
    '--eof',
    '--max-args',
    '--max-chars',
    '--max-lines',
    '--max-procs',
    '--process-slot-var',
    '--replace',
  ]),
};

// The fixed arguments a wrapper takes before the command it runs.
const wrapperArguments: Readonly<Record<string, number>> = {
  chroot: 1,
  chrt: 1,
  flock: 1,
  taskset: 1,
  timeout: 1,
};

// `taskset -c`/`--cpu-list` supplies the CPU list as the option value, so no mask operand follows.
const fixedArgumentsOf = (name: string, options: readonly string[]): number => {
  if (name === 'taskset' && options.some((option) => option === '-c' || option === '--cpu-list')) {
    return 0;
  }

  return wrapperArguments[name] ?? 0;
};

// The external `time` binary takes these value options. A bare `time` is the bash reserved word,
// which takes only `-p`, so the two forms need different option tables.
const externalTimeValueOptions: ReadonlySet<string> = new Set(['-f', '-o', '--format', '--output']);

export const emptyOptionValues: ReadonlySet<string> = new Set();
const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// `command -v` and `command -V`, also combined with `-p`, describe the command instead of running
// it.
const lookupOptionPattern = /^-p*[vV][pvV]*$/u;

const namesInsteadOfRuns = (options: readonly string[]): boolean =>
  options.some((option) => lookupOptionPattern.test(option));

// The reserved word `time` takes only `-p`, and `--` ends its options. Any other dash word is the
// command it runs, so it must not be skipped as an option.
const afterReservedTime = (words: readonly string[], index: number): number => {
  let next = index + 1;

  while (words[next] === '-p') {
    next += 1;
  }

  return words[next] === '--' ? next + 1 : next;
};

// A short-option cluster can hold a value option after its first letter, as `-Eu root` does, and
// the value is either the rest of the word or the next one. Returns the index after the option.
const optionWordEnd = (
  words: readonly string[],
  index: number,
  valueOptions: ReadonlySet<string>,
): number => {
  const word = words[index] ?? '';

  if (valueOptions.has(word)) {
    return index + 2;
  }

  if (word.startsWith('--')) {
    return index + 1;
  }

  const letters = word.slice(1);

  for (let position = 0; position < letters.length; position += 1) {
    if (!valueOptions.has(`-${letters[position] ?? ''}`)) {
      continue;
    }

    return position === letters.length - 1 ? index + 2 : index + 1;
  }

  return index + 1;
};

export const optionEnd = (
  words: readonly string[],
  start: number,
  valueOptions: ReadonlySet<string>,
): number => {
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (word === '--') {
      return index + 1;
    }

    if (!word.startsWith('-')) {
      return index;
    }

    index = optionWordEnd(words, index, valueOptions);
  }

  return index;
};

// Advances past leading keywords, assignments, and a reserved `time` word with its flags. A
// compound opener or closer counts as leading when the caller asks for it, so a compound nested in
// the same command opens at its own word.
export const afterLeadingWords = (
  words: readonly string[],
  start: number,
  reservedTime: boolean,
  isLeading: (word: string) => boolean = () => false,
): number => {
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (commandKeywords.has(word) || assignmentPattern.test(word) || isLeading(word)) {
      index += 1;
    } else if (reservedTime && word === 'time') {
      index = afterReservedTime(words, index);
    } else {
      return index;
    }
  }

  return index;
};

// A wrapper's options may sit before or after its fixed operands, as in
// `flock /tmp/lock -w 5 sh -c ...`. The command it runs starts after both.
const afterWrapper = (
  words: readonly string[],
  afterOptions: number,
  valueOptions: ReadonlySet<string>,
  fixedArguments: number,
): number => {
  if (fixedArguments === 0) {
    return afterOptions;
  }

  return optionEnd(words, afterOptions + fixedArguments, valueOptions);
};

// A wrapper's options differ by name. A `time` wrapper is the external binary, because commandStart
// handles the bare reserved word before it reads this table.
const wrapperValueOptionsOf = (word: string): ReadonlySet<string> | undefined => {
  const name = commandNameOf(word);

  if (name === 'time') {
    return externalTimeValueOptions;
  }

  return Object.hasOwn(wrapperValueOptions, name) ? wrapperValueOptions[name] : undefined;
};

// Walks the leading assignments, keywords, and wrappers to the command they run.
export const commandStart = (words: readonly string[]): CommandStart => {
  const wrappers: { name: string; index: number }[] = [];
  let index = 0;
  let lookup = false;

  while (index < words.length) {
    const word = words[index] ?? '';
    const name = commandNameOf(word);
    const valueOptions = wrapperValueOptionsOf(word);
    // A bare `time` is the reserved word only before any wrapper. After one it is the external
    // binary, whose own options the wrapper table below reads.
    const afterLeading = afterLeadingWords(words, index, wrappers.length === 0);

    if (afterLeading !== index) {
      index = afterLeading;
    } else if (valueOptions === undefined) {
      break;
    } else {
      const afterOptions = optionEnd(words, index + 1, valueOptions);
      const options = words.slice(index + 1, afterOptions);

      lookup ||= name === 'command' && namesInsteadOfRuns(options);
      wrappers.push({ name, index });
      index = afterWrapper(words, afterOptions, valueOptions, fixedArgumentsOf(name, options));
    }
  }

  return { index: Math.min(index, words.length), wrappers, lookup };
};

const envWhitespace: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\v', '\f']);

const envEscapeCharacters: Readonly<Record<string, string>> = {
  '#': '#',
  $: '$',
  '"': '"',
  "'": "'",
  '\\': '\\',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

const envEscape = (value: string, index: number, inDoubleQuotes: boolean): EnvEscape => {
  const next = value[index + 1];

  if (next === undefined) {
    return { kind: 'invalid' };
  }

  if (next === 'c') {
    return inDoubleQuotes ? { kind: 'invalid' } : { kind: 'stop' };
  }

  if (next === '_') {
    return inDoubleQuotes
      ? { kind: 'character', value: ' ', end: index + 2 }
      : { kind: 'separator', end: index + 2 };
  }

  const character = envEscapeCharacters[next];

  return character === undefined
    ? { kind: 'invalid' }
    : { kind: 'character', value: character, end: index + 2 };
};

const isSingleQuoteEscape = (character: string | undefined): boolean =>
  character === "'" || character === '\\';

// A `#` at the start of an argument comments out the rest, and `\c` ends the string.
const finishEnvWord = (state: EnvSplitState): void => {
  if (state.started) {
    state.words.push(state.word);
    state.word = '';
    state.started = false;
  }
};

const appendEnvText = (state: EnvSplitState, text: string): void => {
  state.word += text;
  state.started = true;
};

// Single quotes keep every character literal except \' and \\.
const readSingleQuotedCharacter = (
  value: string,
  state: EnvSplitState,
): EnvSplitString | undefined => {
  const character = value[state.index] ?? '';

  if (character === "'") {
    state.quote = undefined;
    state.index += 1;

    return undefined;
  }

  if (character === '\\' && isSingleQuoteEscape(value[state.index + 1])) {
    appendEnvText(state, value[state.index + 1] ?? '');
    state.index += 2;

    return undefined;
  }

  appendEnvText(state, character);
  state.index += 1;

  return undefined;
};

const readDoubleQuotedCharacter = (
  value: string,
  state: EnvSplitState,
): EnvSplitString | undefined => {
  const character = value[state.index] ?? '';

  if (character === '"') {
    state.quote = undefined;
    state.index += 1;

    return undefined;
  }

  if (character === '$') {
    return { kind: 'unreadable' };
  }

  if (character !== '\\') {
    appendEnvText(state, character);
    state.index += 1;

    return undefined;
  }

  const escaped = envEscape(value, state.index, true);

  if (escaped.kind === 'invalid' || escaped.kind === 'stop') {
    return { kind: 'ignored' };
  }

  if (escaped.kind === 'separator') {
    finishEnvWord(state);
    state.index = escaped.end;

    return undefined;
  }

  appendEnvText(state, escaped.value);
  state.index = escaped.end;

  return undefined;
};

const readUnquotedEscape = (value: string, state: EnvSplitState): EnvSplitString | undefined => {
  const escaped = envEscape(value, state.index, false);

  if (escaped.kind === 'invalid') {
    return { kind: 'ignored' };
  }

  if (escaped.kind === 'stop') {
    finishEnvWord(state);

    return { kind: 'words', words: state.words };
  }

  if (escaped.kind === 'separator') {
    finishEnvWord(state);
    state.index = escaped.end;

    return undefined;
  }

  appendEnvText(state, escaped.value);
  state.index = escaped.end;

  return undefined;
};

const readUnquotedCharacter = (value: string, state: EnvSplitState): EnvSplitString | undefined => {
  const character = value[state.index] ?? '';

  if (envWhitespace.has(character)) {
    finishEnvWord(state);
    state.index += 1;

    return undefined;
  }

  if (character === '#' && !state.started) {
    return { kind: 'words', words: state.words };
  }

  if (character === "'" || character === '"') {
    state.quote = character === "'" ? 'single' : 'double';
    state.started = true;
    state.index += 1;

    return undefined;
  }

  if (character === '$') {
    return { kind: 'unreadable' };
  }

  if (character !== '\\') {
    appendEnvText(state, character);
    state.index += 1;

    return undefined;
  }

  return readUnquotedEscape(value, state);
};

// A `#` at the start of an argument comments out the rest, and `\c` ends the string.
export const splitEnvString = (value: string): EnvSplitString => {
  const state: EnvSplitState = {
    words: [],
    word: '',
    started: false,
    index: 0,
    quote: undefined,
  };

  while (state.index < value.length) {
    let result: EnvSplitString | undefined;

    if (state.quote === 'single') {
      result = readSingleQuotedCharacter(value, state);
    } else if (state.quote === 'double') {
      result = readDoubleQuotedCharacter(value, state);
    } else {
      result = readUnquotedCharacter(value, state);
    }

    if (result !== undefined) {
      return result;
    }
  }

  if (state.quote !== undefined) {
    return { kind: 'ignored' };
  }

  finishEnvWord(state);

  return { kind: 'words', words: state.words };
};

const splitStringPrefix = '--split-string=';
const splitStringOptionLetter = 'S';

const splitStringAt = (
  words: readonly string[],
  index: number,
  valueOptions: ReadonlySet<string>,
): { value: string; end: number } | undefined => {
  const word = words[index] ?? '';

  if (word.startsWith(splitStringPrefix)) {
    return { value: word.slice(splitStringPrefix.length), end: index + 1 };
  }

  if (!word.startsWith('-') || word.startsWith('--')) {
    return undefined;
  }

  const letters = word.slice(1);

  for (let position = 0; position < letters.length; position += 1) {
    const letter = letters[position] ?? '';

    if (letter === splitStringOptionLetter) {
      const attached = letters.slice(position + 1);

      return attached === ''
        ? { value: words[index + 1] ?? '', end: index + 2 }
        : { value: attached, end: index + 1 };
    }

    if (valueOptions.has(`-${letter}`)) {
      return undefined;
    }
  }

  return undefined;
};

// Finds an `env` split string among its options. The scan stops at `--` or at the first operand,
// because `env` stops reading options there.
const envSplitString = (words: readonly string[], start: number): EnvSplit | undefined => {
  const envValueOptions = wrapperValueOptions.env ?? emptyOptionValues;
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';
    const split = splitStringAt(words, index, envValueOptions);

    if (split !== undefined) {
      const parsed = splitEnvString(split.value);

      if (parsed.kind === 'unreadable') {
        return { kind: 'unreadable' };
      }

      return parsed.kind === 'words'
        ? { kind: 'split', words: parsed.words, end: split.end }
        : { kind: 'split', words: [], end: split.end };
    }

    if (word === '--' || !word.startsWith('-')) {
      return undefined;
    }

    index = optionWordEnd(words, index, envValueOptions);
  }

  return undefined;
};

// Only an `env` that runs the command may split its value. An `env` word after the command is an
// ordinary argument, which the shell passes on unsplit. A split value may itself start with an
// `env` wrapper, so the first split string is expanded and the result is read again.
const envSplitIn = (words: readonly string[]): { index: number; split: EnvSplit } | undefined => {
  for (const { name, index } of commandStart(words).wrappers) {
    if (name !== 'env') {
      continue;
    }

    const split = envSplitString(words, index + 1);

    if (split !== undefined) {
      return { index, split };
    }
  }

  return undefined;
};

// Every pass consumes a word that contains whitespace, or shortens the list, so the loop ends. An
// unreadable split string drops the `env` command and everything after it, so the caller sees no
// command and must fail closed on `unreadable`.
export const withEnvSplitStrings = (words: readonly string[]): ExpandedWords => {
  let result = [...words];

  for (;;) {
    const found = envSplitIn(result);

    if (found === undefined) {
      return { words: result, unreadable: false };
    }

    if (found.split.kind === 'unreadable') {
      return { words: result.slice(0, found.index), unreadable: true };
    }

    result = [
      ...result.slice(0, found.index + 1),
      ...found.split.words,
      ...result.slice(found.split.end),
    ];
  }
};

// The words a wrapper or keyword runs as a command. `lookup` is true when a `command -v` or
// `command -V` wrapper names a command instead of running it. `unreadable` is true when an `env -S`
// value cannot be resolved, so no command can be named.
export const commandWords = (words: readonly string[]): CommandWords => {
  const expanded = withEnvSplitStrings(words);
  const { index, lookup } = commandStart(expanded.words);

  return { words: expanded.words.slice(index), lookup, unreadable: expanded.unreadable };
};

// The shell builtins that run the command after them in the current shell. A wrapper such as `env`
// or `sudo` starts a child process instead, so the `exec` it runs does not change this shell.
const shellQualifierNames: ReadonlySet<string> = new Set(['builtin', 'command']);

// Whether the words run the shell's own `exec` with no command, so it changes the descriptors of
// the shell that runs it. Only a keyword, `time`, or a shell qualifier may sit before `exec`.
export const runsRedirectionsOnlyExec = (words: readonly string[]): boolean => {
  let index = 0;
  let afterQualifier = false;

  while (index < words.length) {
    const word = words[index] ?? '';
    const name = commandNameOf(word);
    // Bash reads a reserved word only in command position, so a qualifier such as `command` turns
    // the words after it into ordinary arguments.
    const afterLeading = afterQualifier ? index : afterLeadingWords(words, index, true);

    if (afterLeading !== index) {
      index = afterLeading;
    } else if (shellQualifierNames.has(name)) {
      const afterOptions = optionEnd(words, index + 1, emptyOptionValues);
      const options = words.slice(index + 1, afterOptions);

      if (namesInsteadOfRuns(options)) {
        return false;
      }

      index = afterOptions;
      afterQualifier = true;
    } else {
      break;
    }
  }

  const head = words[index];

  if (head === undefined || commandNameOf(head) !== 'exec') {
    return false;
  }

  const execOptions = wrapperValueOptions.exec ?? emptyOptionValues;

  return optionEnd(words, index + 1, execOptions) === words.length;
};
