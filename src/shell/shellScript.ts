import {
  commandNameOf,
  commandStart,
  emptyOptionValues,
  optionEnd,
  withEnvSplitStrings,
  wrapperValueOptions,
} from '../wrapperAnalysis.js';

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

// `--` only ends option parsing, so it never names the script. The script word comes after it.
const afterOptionTerminator = (words: readonly string[], index: number): number =>
  words[index] === '--' ? index + 1 : index;

// A shell runs a `-c` script only when `-c` is an option. A positional operand names a script file
// instead, so the scan stops there and after `--`. A flag word can set `c` and take a value at once,
// as `-co pipefail` does, so the scan remembers `c` until it reaches the script word.
const shellOptionScript = (words: readonly string[]): string | undefined => {
  let index = 0;
  let namesScript = false;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (word === '--' || !isShellOptionWord(word)) {
      const scriptIndex = afterOptionTerminator(words, index);
      const script = words[scriptIndex];

      return namesScript ? script : undefined;
    }

    const consumesValue = takesShellOptionValue(word);
    const namesScriptHere = namesShellScript(word);

    namesScript ||= namesScriptHere;

    if (consumesValue) {
      index += 2;

      continue;
    }

    if (namesScriptHere) {
      const scriptIndex = afterOptionTerminator(words, index + 1);

      return words[scriptIndex];
    }

    index += 1;
  }

  return undefined;
};

const flockCommandPrefix = '--command=';

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

// The script a command runs through a shell: a shell's `-c` word, a wrapper's script option, or
// the words `watch` joins.
export const shellScriptOf = (words: readonly string[]): string | undefined => {
  const expanded = withEnvSplitStrings(words);
  const { index, wrappers, lookup } = commandStart(expanded);

  if (lookup) {
    return undefined;
  }

  const headName = commandNameOf(expanded[index] ?? '');

  if (shellNames.has(headName)) {
    return shellOptionScript(expanded.slice(index + 1));
  }

  const scriptWrapper = wrappers.findLast(({ name }) => scriptWrapperNames.has(name));

  return scriptWrapper === undefined
    ? undefined
    : wrapperScript(scriptWrapper.name, expanded.slice(scriptWrapper.index));
};
