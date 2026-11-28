import { takesShellOptionValue } from '../../shell/shellScript.js';
import { matchingBrace } from './braceMatching.js';
import { isUnresolvedWord, startsWithExpansion } from './unresolvedWords.js';

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

interface ModeState {
  namesStdin: boolean;
  optionMayBeCode: boolean;
}

interface UnwrappedAlternative {
  readonly truncated: boolean;
  readonly word: string;
}

interface Codes {
  readonly seen: Set<string>;
  readonly values: string[];
}

export const isOptionWord = (word: string): boolean => word.startsWith('-') || word.startsWith('+');

// A brace expansion can start a word with an option when its first alternative does, as in
// `{-O,extglob}`.
const braceAlternatives = (word: string): string[] | undefined => {
  if (!word.startsWith('{')) {
    return undefined;
  }

  const close = matchingBrace(word, 0);

  if (close === undefined) {
    return undefined;
  }

  const alternatives: string[] = [];
  let depth = 0;
  let start = 1;

  for (let index = 1; index < close; index += 1) {
    const character = word[index];

    if (character === '{') {
      depth += 1;

      continue;
    }

    if (character === '}') {
      depth -= 1;

      continue;
    }

    if (character === ',' && depth === 0) {
      alternatives.push(word.slice(start, index));
      start = index + 1;
    }
  }

  alternatives.push(word.slice(start, close));

  return alternatives;
};

const braceFirstAlternative = (word: string): string | undefined => braceAlternatives(word)?.[0];

export const maximumBraceDepth = 100;

const unwrapFirstAlternative = (word: string): UnwrappedAlternative => {
  let current = word;

  for (let depth = 0; depth < maximumBraceDepth; depth += 1) {
    const inner = braceFirstAlternative(current);

    if (inner === undefined) {
      return { truncated: false, word: current };
    }

    current = inner;
  }

  return { truncated: braceFirstAlternative(current) !== undefined, word: current };
};

const nameCharacters = /[A-Za-z_0-9]/u;

const specialParameters = new Set(['@', '*', '!', '-']);

const nonEmptyBracedBodies = new Set(['0', '?', '$']);

const bracedCanBeEmpty = (body: string): boolean =>
  !nonEmptyBracedBodies.has(body) && !body.startsWith('#');

const bracedExpansion = (word: string, start: number): Expansion | undefined => {
  const close = matchingBrace(word, start + 1);

  return close === undefined
    ? undefined
    : { end: close + 1, canBeEmpty: bracedCanBeEmpty(word.slice(start + 2, close)) };
};

const parenthesizedExpansion = (word: string, start: number): Expansion | undefined => {
  const close = word.indexOf(')', start + 2);

  return close === -1 ? undefined : { end: close + 1, canBeEmpty: true };
};

const nameExpansion = (word: string, start: number): Expansion => {
  const first = word[start + 1] ?? '';

  if (/[0-9]/u.test(first)) {
    return { end: start + 2, canBeEmpty: first !== '0' };
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

const braceStartsWithModeOption = (alternative: string | undefined): boolean => {
  if (alternative === undefined) {
    return false;
  }

  const unwrapped = unwrapFirstAlternative(alternative);

  return unwrapped.truncated || isOptionWord(unwrapped.word) || startsWithExpansion(unwrapped.word);
};

const hasExpansionPrefix = (word: string): boolean =>
  startsWithExpansion(word) || braceStartsWithModeOption(braceFirstAlternative(word));

// Only a word whose text could expand to an option can be a mode option. Any other unresolved
// word is a file operand, so the words after it and the standard input are data.
const isModeOptionWord = (word: string): boolean => isOptionWord(word) || hasExpansionPrefix(word);

const namesMayBeCode = (names: string[]): boolean => names.some(isModeOptionWord);

const emptyCodes = (): Codes => ({ seen: new Set<string>(), values: [] });

export const stdinMode = (codes: readonly string[]): ShellMode => ({
  kind: 'stdin',
  codes: [...codes],
});

const addCodes = (codes: Codes, next: readonly string[]): void => {
  if (next.length === 0) {
    return;
  }

  for (const code of next) {
    if (codes.seen.has(code)) {
      continue;
    }

    codes.seen.add(code);
    codes.values.push(code);
  }
};

const copyCodes = (codes: Codes, extra: readonly string[]): Codes => {
  const copy = emptyCodes();

  addCodes(copy, codes.values);
  addCodes(copy, extra);

  return copy;
};

const fileMode = (
  names: string[],
  codes: readonly string[],
  stdinMayBeCode: boolean,
): ShellMode => ({
  kind: 'file',
  names,
  codes: [...codes],
  stdinMayBeCode,
});

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

    if (takesShellOptionValue(word)) {
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

const resolvedModeStep = (
  words: string[],
  index: number,
  codes: Codes,
  state: ModeState,
): ResolvedModeStep => {
  const word = words[index] ?? '';
  const attached = attachedInlineCode(word);

  if (attached !== undefined) {
    return { kind: 'mode', mode: { kind: 'inline', codes: copyCodes(codes, [attached]).values } };
  }

  if (isInlineCodeWord(word)) {
    const code = codeOperand(words, index + 1);
    const nextCodes = code === undefined ? codes : copyCodes(codes, [code]);

    return { kind: 'mode', mode: { kind: 'inline', codes: nextCodes.values } };
  }

  state.namesStdin ||= isStdinOptionWord(word);

  // After `-s`, a word that is not an option is a positional argument, so the shell still reads
  // its code from standard input.
  if (state.namesStdin && !isOptionWord(word)) {
    return { kind: 'mode', mode: stdinMode(codes.values) };
  }

  if (takesShellOptionValue(word)) {
    return { kind: 'skip', next: index + 2 };
  }

  if (isStdinOptionWord(word)) {
    return { kind: 'skip', next: index + 1 };
  }

  if (!isOptionWord(word)) {
    return { kind: 'mode', mode: fileMode([word], codes.values, false) };
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
  const file = names.length === 0 && !isOptionWord(word) ? word : undefined;
  const code = codeOperand(words, index + 1);

  return { file, codes: code === undefined ? [] : [code] };
};

// `--` ends option scanning only while it is active. A candidate recorded before it stays a
// candidate and `--` is data for that candidate. Otherwise the next word is a file operand, and
// the words after it are positional arguments, never code.
const modeAtDoubleDash = (
  words: string[],
  index: number,
  codes: Codes,
  names: string[],
  optionMayBeCode: boolean,
): ShellMode => {
  const name = words[index + 1];

  if (names.length > 0) {
    const candidates = name === undefined ? names : [...names, name];
    const nextCodes = name === undefined ? codes : copyCodes(codes, [name]);

    return fileMode(candidates, nextCodes.values, namesMayBeCode(names) || optionMayBeCode);
  }

  if (name === undefined) {
    return stdinMode(codes.values);
  }

  // Every vanishing word is dropped, so the first word that cannot vanish becomes the file
  // operand. Standard input is code only when no word remains.
  let end = index + 1;

  while (end < words.length && canExpandToNoWord(words[end] ?? '')) {
    end += 1;
  }

  const candidates = words.slice(index + 1, Math.min(end + 1, words.length));

  return fileMode(candidates, codes.values, end >= words.length || optionMayBeCode);
};

// A file candidate from an ambiguous word still runs when a later word decides the mode, so keep it
// in a file result next to that mode's code.
const candidatesWithMode = (
  names: string[],
  mode: ShellMode,
  optionMayBeCode: boolean,
): ShellMode => {
  if (names.length === 0) {
    return mode;
  }

  if (mode.kind === 'inline') {
    return fileMode(names, mode.codes, optionMayBeCode);
  }

  if (mode.kind === 'stdin') {
    return fileMode(names, mode.codes, true);
  }

  return mode;
};

// The words a brace mode option leaves for the shell after its first alternative. A first
// alternative with `c` makes the rest the code. A first alternative that starts with an expansion
// may become either code or an option, so the rest are both code and file candidates. A plain
// option makes them file operands; a value-taking option consumes its value first.
const braceFollowWords = (alternatives: string[]): { codes: string[]; names: string[] } => {
  const rawFirst = alternatives[0] ?? '';
  const unwrapped = unwrapFirstAlternative(rawFirst);
  const rest = alternatives.slice(1);

  if (unwrapped.truncated) {
    return { codes: rest, names: rest };
  }

  const first = unwrapped.word;

  if (isInlineCodeWord(first)) {
    return { codes: rest, names: [] };
  }

  if (!isOptionWord(first)) {
    return startsWithExpansion(first) ? { codes: rest, names: rest } : { codes: [], names: [] };
  }

  if (!takesShellOptionValue(first)) {
    return { codes: [], names: rest };
  }

  const inner = rawFirst.startsWith('{') ? braceAlternatives(rawFirst) : undefined;
  const valueInsideFirst = (inner?.length ?? 0) > 1;

  return { codes: [], names: valueInsideFirst ? rest : alternatives.slice(2) };
};

// A mode option may also be a brace expansion that yields several words. Record its file
// candidate and every word that may follow it.
const unresolvedOptionStep = (
  words: string[],
  index: number,
  codes: Codes,
  names: string[],
): void => {
  const word = words[index] ?? '';
  const step = unresolvedModeStep(words, index, names);

  if (step.file !== undefined) {
    names.push(step.file);
  }

  const alternatives = braceAlternatives(word);

  if (alternatives !== undefined) {
    const follow = braceFollowWords(alternatives);

    addCodes(codes, follow.codes);
    names.push(...follow.names);
  }

  addCodes(codes, step.codes);
};

const fileOperandMode = (names: string[], codes: Codes, state: ModeState): ShellMode =>
  fileMode(names, codes.values, namesMayBeCode(names) || state.optionMayBeCode);

// An unresolved mode word either names a file operand itself or keeps the scan going as a
// possible option.
const unresolvedMode = (
  words: string[],
  index: number,
  codes: Codes,
  names: string[],
  state: ModeState,
): ShellMode | undefined => {
  const word = words[index] ?? '';

  if (!isModeOptionWord(word)) {
    if (state.namesStdin) {
      return candidatesWithMode(names, stdinMode(codes.values), state.optionMayBeCode);
    }

    names.push(word);

    return fileOperandMode(names, codes, state);
  }

  state.optionMayBeCode ||= isOptionWord(word);
  unresolvedOptionStep(words, index, codes, names);

  return undefined;
};

export const shellMode = (words: string[]): ShellMode => {
  const codes = emptyCodes();
  const names: string[] = [];
  const state: ModeState = { namesStdin: false, optionMayBeCode: false };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (word === '--' || word === '-') {
      if (state.namesStdin) {
        return candidatesWithMode(names, stdinMode(codes.values), state.optionMayBeCode);
      }

      return modeAtDoubleDash(words, index, codes, names, state.optionMayBeCode);
    }

    if (isUnresolvedWord(word)) {
      const mode = unresolvedMode(words, index, codes, names, state);

      if (mode !== undefined) {
        return mode;
      }

      continue;
    }

    const step = resolvedModeStep(words, index, codes, state);

    if (step.kind === 'skip') {
      index = step.next - 1;

      continue;
    }

    // A later literal word is a second candidate while the first word could be an option, and then
    // the scan ends because the words after it are positional.
    if (step.mode.kind === 'file') {
      names.push(...step.mode.names);

      return fileOperandMode(names, codes, state);
    }

    return candidatesWithMode(names, step.mode, state.optionMayBeCode);
  }

  if (names.length > 0) {
    return fileOperandMode(names, codes, state);
  }

  return stdinMode(codes.values);
};
