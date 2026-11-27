// Reads the command a shell word list runs, past its leading keywords, assignments, and wrappers.
// The tokenizer stays in shell.ts; this module owns only the wrapper tables and the command head.

export interface CommandWords {
  readonly words: readonly string[];
  readonly lookup: boolean;
}

export interface CommandStart {
  // The index of the word the shell runs as the command, or the word count when none follows.
  readonly index: number;
  readonly wrappers: readonly { readonly name: string; readonly index: number }[];
  readonly lookup: boolean;
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
  command: new Set(),
  doas: new Set(['-C', '-a', '-u']),
  env: new Set(['-C', '-S', '-u', '--chdir', '--split-string', '--unset']),
  exec: new Set(['-a']),
  flock: new Set(['-E', '-c', '-w', '--command', '--conflict-exit-code', '--timeout']),
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set(),
  setsid: new Set(),
  stdbuf: new Set(['-e', '-i', '-o', '--error', '--input', '--output']),
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
  watch: new Set(['-n', '-q', '--equexit', '--interval']),
  xargs: new Set([
    '-a',
    '-d',
    '-E',
    '-I',
    '-L',
    '-n',
    '-P',
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
  flock: 1,
  timeout: 1,
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

    index += valueOptions.has(word) ? 2 : 1;
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
      index = afterWrapper(words, afterOptions, valueOptions, wrapperArguments[name] ?? 0);
    }
  }

  return { index, wrappers, lookup };
};

// `env` splits the value of `-S`/`--split-string` into words and runs the first one, so the value
// is command text rather than an ordinary option value.
const envSplitOptionNames: ReadonlySet<string> = new Set(['-S', '--split-string']);
const splitStringPrefix = '--split-string=';
const splitWordPattern = /\s+/u;

const splitStringAt = (
  words: readonly string[],
  index: number,
): { value: string; end: number } | undefined => {
  const word = words[index] ?? '';

  if (word.startsWith(splitStringPrefix)) {
    return { value: word.slice(splitStringPrefix.length), end: index + 1 };
  }

  if (envSplitOptionNames.has(word)) {
    return { value: words[index + 1] ?? '', end: index + 2 };
  }

  return word.startsWith('-S') && word.length > 2
    ? { value: word.slice(2), end: index + 1 }
    : undefined;
};

// Finds an `env` split string among its options. The scan stops at `--` or at the first operand,
// because `env` stops reading options there.
const envSplitString = (
  words: readonly string[],
  start: number,
): { words: string[]; end: number } | undefined => {
  const envValueOptions = wrapperValueOptions.env ?? emptyOptionValues;
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';
    const split = splitStringAt(words, index);

    if (split !== undefined) {
      const splitWords = split.value.split(splitWordPattern).filter((value) => value !== '');

      return { words: splitWords, end: split.end };
    }

    if (word === '--' || !word.startsWith('-')) {
      return undefined;
    }

    index += envValueOptions.has(word) ? 2 : 1;
  }

  return undefined;
};

// Only an `env` that runs the command may split its value. An `env` word after the command is an
// ordinary argument, which the shell passes on unsplit.
export const withEnvSplitStrings = (words: readonly string[]): readonly string[] => {
  const env = commandStart(words).wrappers.find(({ name }) => name === 'env');

  if (env === undefined) {
    return words;
  }

  const split = envSplitString(words, env.index + 1);

  if (split === undefined) {
    return words;
  }

  return [...words.slice(0, env.index + 1), ...split.words, ...words.slice(split.end)];
};

// The words a wrapper or keyword runs as a command. `lookup` is true when a `command -v` or
// `command -V` wrapper names a command instead of running it.
export const commandWords = (words: readonly string[]): CommandWords => {
  const expanded = withEnvSplitStrings(words);
  const { index, lookup } = commandStart(expanded);

  return { words: expanded.slice(index), lookup };
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
    const afterLeading = afterLeadingWords(words, index, !afterQualifier);

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
