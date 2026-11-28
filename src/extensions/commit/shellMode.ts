import { isUnresolvedWord } from './unresolvedWords.js';

export type ShellMode =
  | { kind: 'inline'; codes: string[] }
  | { kind: 'file'; names: string[]; codes: string[] }
  | { kind: 'stdin'; codes: string[] };

interface ShortOption {
  letters: string;
  // What is attached to the letters, such as `./commit.sh` in `-lc./commit.sh`.
  tail: string;
}

type ResolvedModeStep =
  | { readonly kind: 'mode'; readonly mode: ShellMode }
  | { readonly kind: 'skip'; readonly next: number };

export const isOptionWord = (word: string): boolean => word.startsWith('-') || word.startsWith('+');

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

// A resolved mode word is a code option, a stdin option, an option with a value, a file operand, or
// another option to skip.
const resolvedModeStep = (words: string[], index: number, codes: string[]): ResolvedModeStep => {
  const word = words[index] ?? '';
  const attached = attachedInlineCode(word);

  if (attached !== undefined) {
    return { kind: 'mode', mode: { kind: 'inline', codes: [...codes, attached] } };
  }

  if (isInlineCodeWord(word)) {
    const code = codeOperand(words, index + 1);

    return {
      kind: 'mode',
      mode: { kind: 'inline', codes: code === undefined ? codes : [...codes, code] },
    };
  }

  if (isStdinOptionWord(word)) {
    return { kind: 'mode', mode: { kind: 'stdin', codes } };
  }

  if (optionValueNames.has(word)) {
    return { kind: 'skip', next: index + 2 };
  }

  if (!isOptionWord(word)) {
    return { kind: 'mode', mode: { kind: 'file', names: [word], codes } };
  }

  return { kind: 'skip', next: index + 1 };
};

// An unresolved mode word may expand to `-c`, so the word after it may be the code. It may also be
// the file operand, so the first non-option word is a candidate while option scanning is active.
const unresolvedModeStep = (
  words: string[],
  index: number,
  names: string[],
): { file: string | undefined; codes: string[] } => {
  const word = words[index] ?? '';
  const next = words[index + 1];
  const file = names.length === 0 && !isOptionWord(word) ? word : undefined;

  return { file, codes: next === undefined ? [] : [next] };
};

// `--` ends option scanning only while it is active. A file candidate recorded before it stays a
// candidate and `--` is data for that file. Otherwise the next word is the only candidate, and the
// words after it are positional arguments, never code.
const modeAtDoubleDash = (
  words: string[],
  index: number,
  codes: string[],
  names: string[],
): ShellMode => {
  if (names.length > 0) {
    return { kind: 'file', names, codes };
  }

  const name = words[index + 1];

  return name === undefined ? { kind: 'stdin', codes } : { kind: 'file', names: [name], codes };
};

export const shellMode = (words: string[]): ShellMode => {
  const codes: string[] = [];
  const names: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (word === '--') {
      return modeAtDoubleDash(words, index, codes, names);
    }

    if (isUnresolvedWord(word)) {
      const step = unresolvedModeStep(words, index, names);

      if (step.file !== undefined) {
        names.push(step.file);
      }

      codes.push(...step.codes);

      continue;
    }

    const step = resolvedModeStep(words, index, codes);

    if (step.kind === 'skip') {
      index = step.next - 1;

      continue;
    }

    // A later literal word is a second candidate while the first word could be an option, and then
    // the scan ends because the words after it are positional.
    if (step.mode.kind === 'file') {
      names.push(...step.mode.names);

      return { kind: 'file', names, codes };
    }

    return step.mode;
  }

  if (names.length > 0) {
    return { kind: 'file', names, codes };
  }

  return { kind: 'stdin', codes };
};
