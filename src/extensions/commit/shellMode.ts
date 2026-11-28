import { isUnresolvedWord } from './unresolvedWords.js';

export type ShellMode =
  | { kind: 'inline'; codes: string[] }
  | { kind: 'file'; names: string[]; codes: string[]; stdinMayBeCode: boolean }
  | { kind: 'stdin'; codes: string[] };

interface ShortOption {
  letters: string;
  // What is attached to the letters, such as `./commit.sh` in `-lc./commit.sh`.
  tail: string;
}

type ResolvedModeStep =
  | { readonly kind: 'mode'; readonly mode: ShellMode }
  | { readonly kind: 'skip'; readonly next: number };

interface Expansion {
  readonly end: number;
  readonly canBeEmpty: boolean;
}

export const isOptionWord = (word: string): boolean => word.startsWith('-') || word.startsWith('+');

// A brace expansion can start a word with an option when its first alternative does, as in
// `{-O,extglob}`.
const braceFirstAlternative = (word: string): string | undefined => {
  if (!word.startsWith('{')) {
    return undefined;
  }

  const close = word.indexOf('}');

  return close === -1 ? undefined : (word.slice(1, close).split(',')[0] ?? '');
};

const nameCharacters = /[A-Za-z_0-9]/u;

const specialParameters = new Set(['@', '*', '#', '?', '!', '-']);

const bracedExpansion = (word: string, start: number): Expansion | undefined => {
  const close = word.indexOf('}', start + 2);

  return close === -1
    ? undefined
    : { end: close + 1, canBeEmpty: !word.slice(start + 2, close).startsWith('#') };
};

const parenthesizedExpansion = (word: string, start: number): Expansion | undefined => {
  const close = word.indexOf(')', start + 2);

  return close === -1 ? undefined : { end: close + 1, canBeEmpty: true };
};

const nameExpansion = (word: string, start: number): Expansion => {
  const first = word[start + 1] ?? '';

  if (/[0-9]/u.test(first)) {
    return { end: start + 2, canBeEmpty: true };
  }

  let index = start + 2;

  while (index < word.length && nameCharacters.test(word[index] ?? '')) {
    index += 1;
  }

  return { end: index, canBeEmpty: true };
};

const dollarExpansion = (word: string, start: number): Expansion | undefined => {
  const next = word[start + 1];

  if (next === '{') {
    return bracedExpansion(word, start);
  }

  if (next === '(') {
    return parenthesizedExpansion(word, start);
  }

  if (next !== undefined && nameCharacters.test(next)) {
    return nameExpansion(word, start);
  }

  if (next === '$') {
    return { end: start + 2, canBeEmpty: false };
  }

  return next !== undefined && specialParameters.has(next)
    ? { end: start + 2, canBeEmpty: true }
    : undefined;
};

// A word made only of expansions that may each expand to nothing can expand to no word, so the
// shell drops it and reads its code from standard input. Scan once from left to right; every step
// advances past the expansion it reads, so a long adversarial word stays linear.
const canExpandToNoWord = (word: string): boolean => {
  if (word === '') {
    return false;
  }

  let index = 0;
  let sawExpansion = false;

  while (index < word.length) {
    const character = word[index];

    if (character === '$') {
      const expansion = dollarExpansion(word, index);

      if (expansion === undefined || !expansion.canBeEmpty) {
        return false;
      }

      sawExpansion = true;
      index = expansion.end;

      continue;
    }

    if (character === '`') {
      const end = word.indexOf('`', index + 1);

      if (end === -1) {
        return false;
      }

      sawExpansion = true;
      index = end + 1;

      continue;
    }

    return false;
  }

  return sawExpansion;
};

// A `$` that starts no expansion and an unclosed backtick are literal text.
const startsWithExpansion = (word: string): boolean => {
  if (word.startsWith('`')) {
    return word.includes('`', 1);
  }

  return word.startsWith('$') && dollarExpansion(word, 0) !== undefined;
};

const braceStartsWithModeOption = (alternative: string | undefined): boolean => {
  if (alternative === undefined) {
    return false;
  }

  return (
    isOptionWord(alternative) ||
    startsWithExpansion(alternative) ||
    braceStartsWithModeOption(braceFirstAlternative(alternative))
  );
};

const hasExpansionPrefix = (word: string): boolean =>
  startsWithExpansion(word) || braceStartsWithModeOption(braceFirstAlternative(word));

// Only a word whose text could expand to an option can be a mode option. Any other unresolved
// word is a file operand, so the words after it and the standard input are data.
const isModeOptionWord = (word: string): boolean => isOptionWord(word) || hasExpansionPrefix(word);

const namesMayBeCode = (names: string[]): boolean => names.some(isModeOptionWord);

const optionValueNames = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);

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
    return { kind: 'mode', mode: { kind: 'file', names: [word], codes, stdinMayBeCode: false } };
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

// `--` ends option scanning only while it is active. A candidate recorded before it stays a
// candidate and `--` is data for that candidate. Otherwise the next word is a file operand, and
// the words after it are positional arguments, never code.
const modeAtDoubleDash = (
  words: string[],
  index: number,
  codes: string[],
  names: string[],
): ShellMode => {
  const name = words[index + 1];

  if (names.length > 0) {
    const candidates = name === undefined ? names : [...names, name];
    const nextCodes = name === undefined ? codes : [...codes, name];

    return {
      kind: 'file',
      names: candidates,
      codes: nextCodes,
      stdinMayBeCode: namesMayBeCode(names),
    };
  }

  if (name === undefined) {
    return { kind: 'stdin', codes };
  }

  if (!canExpandToNoWord(name)) {
    return { kind: 'file', names: [name], codes, stdinMayBeCode: false };
  }

  // When the operand vanishes, the next word becomes the file operand. Standard input is code only
  // when that word can vanish too, or when there is no word after it.
  const following = words[index + 2];
  const candidates = following === undefined ? [name] : [name, following];
  const followingVanishes = following === undefined || canExpandToNoWord(following);

  return { kind: 'file', names: candidates, codes, stdinMayBeCode: followingVanishes };
};

// A file candidate from an ambiguous word still runs when a later word decides the mode, so keep it
// in a file result next to that mode's code.
const candidatesWithMode = (names: string[], mode: ShellMode): ShellMode => {
  if (names.length === 0) {
    return mode;
  }

  if (mode.kind === 'inline') {
    return { kind: 'file', names, codes: mode.codes, stdinMayBeCode: false };
  }

  if (mode.kind === 'stdin') {
    return { kind: 'file', names, codes: mode.codes, stdinMayBeCode: true };
  }

  return mode;
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
      if (!isModeOptionWord(word)) {
        names.push(word);

        return { kind: 'file', names, codes, stdinMayBeCode: namesMayBeCode(names) };
      }

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

      return { kind: 'file', names, codes, stdinMayBeCode: namesMayBeCode(names) };
    }

    return candidatesWithMode(names, step.mode);
  }

  if (names.length > 0) {
    return { kind: 'file', names, codes, stdinMayBeCode: namesMayBeCode(names) };
  }

  return { kind: 'stdin', codes };
};
