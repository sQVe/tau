import {
  commandNameOf,
  commandStart,
  emptyOptionValues,
  optionEnd,
  withEnvSplitStrings,
  wrapperValueOptions,
} from '../wrapperAnalysis.js';

// The script a command runs through a shell: a shell's `-c` word, a wrapper's script option, or
// the words `watch` joins. An `env -S` value that cannot be resolved has no script the caller can
// read, so the caller must not treat the command as running no script.
export type ShellScript =
  | { readonly kind: 'script'; readonly script: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable' };

const shellNames: ReadonlySet<string> = new Set([
  'ash',
  'bash',
  'dash',
  'ksh',
  'mksh',
  'sh',
  'zsh',
]);

// The wrappers that run a script through a shell, and the options that name that script. `watch`
// has no option: it joins its remaining words and hands them to `sh -c`.
const scriptWrapperNames: ReadonlySet<string> = new Set(['flock', 'watch']);
const flockScriptOptions: ReadonlySet<string> = new Set(['-c', '--command']);

// A shell option word may take the next word as its value, as `-o pipefail` and `--rcfile file` do.
const shellValueOptions: ReadonlySet<string> = new Set(['--init-file', '--rcfile']);

const startsLikeOption = (word: string): boolean => word.startsWith('-') || word.startsWith('+');

const isShellOptionWord = (word: string): boolean => word.length > 1 && startsLikeOption(word);

const takesShellOptionValue = (word: string): boolean =>
  shellValueOptions.has(word) || /^[-+][a-zA-Z]*[oO]$/u.test(word);

// A `-c` flag names a script only when it is not the value of an `-o`/`-O` option earlier in the
// same word, as `bash -oc cmd` means `-o c` and takes `cmd` as a script file.
const namesShellScript = (word: string): boolean => {
  if (!startsLikeOption(word) || word.startsWith('--')) {
    return false;
  }

  for (const letter of word.slice(1)) {
    if (letter === 'o' || letter === 'O') {
      return false;
    }

    if (letter === 'c') {
      return true;
    }
  }

  return false;
};

// A shell runs the script named after its options. `-c` takes the first non-option operand, or the
// word after `--`, as the script. A flag word can set `c` and take a value at once, as `-co
// pipefail` does, so the scan remembers `c` until it reaches the script word.
const shellOptionScript = (words: readonly string[]): string | undefined => {
  let index = 0;
  let namesScript = false;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (word === '--') {
      const script = words[index + 1];

      return namesScript ? script : undefined;
    }

    if (!isShellOptionWord(word)) {
      return namesScript ? word : undefined;
    }

    const consumesValue = takesShellOptionValue(word);

    namesScript ||= namesShellScript(word);
    index += consumesValue ? 2 : 1;
  }

  return undefined;
};

const flockCommandPrefix = '--command=';

// `flock` reads a short-option cluster with getopt, so `-xc` sets `-x` and names the script with the
// rest of the word or the next one. A value-taking letter before `c` consumes the rest, so `-wc`
// names no script.
const flockClusterScript = (
  words: readonly string[],
  index: number,
  word: string,
): string | undefined => {
  if (!word.startsWith('-') || word.startsWith('--')) {
    return undefined;
  }

  const letters = word.slice(1);

  for (let position = 0; position < letters.length; position += 1) {
    const letter = letters[position];

    if (letter === 'c') {
      const attached = letters.slice(position + 1);

      return attached === '' ? words[index + 1] : attached;
    }

    if (letter === 'w' || letter === 'E') {
      return undefined;
    }
  }

  return undefined;
};

const scriptOptionValue = (
  words: readonly string[],
  start: number,
  end: number,
): string | undefined => {
  for (let index = start; index < end; index += 1) {
    const word = words[index] ?? '';

    const inlineValue = word.startsWith(flockCommandPrefix)
      ? word.slice(flockCommandPrefix.length)
      : undefined;

    if (inlineValue !== undefined) {
      return inlineValue;
    }

    if (flockScriptOptions.has(word)) {
      return words[index + 1];
    }

    const cluster = flockClusterScript(words, index, word);

    if (cluster !== undefined) {
      return cluster;
    }
  }

  return undefined;
};

// `flock` takes its script as an option value, either before or after the lock file, in the option
// word itself or as the next word.
const flockScript = (words: readonly string[]): string | undefined => {
  const valueOptions = wrapperValueOptions.flock ?? emptyOptionValues;
  const fileIndex = optionEnd(words, 1, valueOptions);
  const beforeFile = scriptOptionValue(words, 1, fileIndex);
  const afterFileEnd = optionEnd(words, fileIndex + 1, valueOptions);
  const afterFile = scriptOptionValue(words, fileIndex + 1, afterFileEnd);

  return beforeFile ?? afterFile;
};

// `watch` joins its remaining words and hands them to `sh -c`, so they are the script text.
const watchScript = (words: readonly string[]): string | undefined => {
  const start = optionEnd(words, 1, wrapperValueOptions.watch ?? emptyOptionValues);
  const script = words.slice(start).join(' ');

  return script === '' ? undefined : script;
};

const wrapperScript = (name: string, words: readonly string[]): string | undefined =>
  name === 'watch' ? watchScript(words) : flockScript(words);

const scriptVariant = (script: string | undefined): ShellScript =>
  script === undefined ? { kind: 'none' } : { kind: 'script', script };

export const shellScriptOf = (words: readonly string[]): ShellScript => {
  const expanded = withEnvSplitStrings(words);
  const { index, wrappers, lookup } = commandStart(expanded.words);

  // A lookup names a command instead of running it, so an unreadable value after it runs nothing.
  if (lookup) {
    return { kind: 'none' };
  }

  if (expanded.unreadable) {
    return { kind: 'unreadable' };
  }

  const headName = commandNameOf(expanded.words[index] ?? '');

  if (shellNames.has(headName)) {
    return scriptVariant(shellOptionScript(expanded.words.slice(index + 1)));
  }

  const scriptWrapper = wrappers.findLast(({ name }) => scriptWrapperNames.has(name));

  if (scriptWrapper === undefined) {
    return { kind: 'none' };
  }

  return scriptVariant(
    wrapperScript(scriptWrapper.name, expanded.words.slice(scriptWrapper.index)),
  );
};

// The shell a command runs, so a caller can judge a script the shell reads from standard input.
export const shellNameOf = (words: readonly string[]): string | undefined => {
  const expanded = withEnvSplitStrings(words);

  if (expanded.unreadable) {
    return undefined;
  }

  const { index, lookup } = commandStart(expanded.words);

  if (lookup) {
    return undefined;
  }

  const headName = commandNameOf(expanded.words[index] ?? '');

  return shellNames.has(headName) ? headName : undefined;
};
