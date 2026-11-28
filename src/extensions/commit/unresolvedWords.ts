import { commandNameOf } from '../../wrapperAnalysis.js';
import { optionValue } from './optionValue.js';

// Shell code is text that a shell, `eval`, or `env -S` is known to run. In shell code, assume a
// variable holds its worst value: block when one sits in a word that decides the command. Those
// words are the command name, a Git word before the subcommand, and the shell's mode word, whose
// worst value is `-c`. A variable in any other word is data.
export type TextOrigin =
  | { readonly kind: 'toolCommand' }
  | { readonly kind: 'shellCode' }
  | { readonly kind: 'scriptCandidate' };

// Git options whose value Git takes from the next word, so that value is never the subcommand.
const gitOptionValueNames = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
  '--attr-source',
]);

// A brace expansion starts with a `{` that is not part of a parameter expansion, which begins with
// `${`. A lone brace is a structural token, not a value.
const isBraceExpansion = (word: string): boolean => /(?<!\$)\{/u.test(word) && word.includes('}');

const isStructuralBrace = (word: string): boolean => word === '}' || word === '{';

const nameCharacters = /[A-Za-z_0-9]/u;

const expansionPunctuation = new Set(['{', '(', '$']);

const specialParameters = new Set(['@', '*', '!', '-', '?', '#']);

const startsExpansion = (text: string, index: number): boolean => {
  const next = text[index + 1] ?? '';

  return expansionPunctuation.has(next) || nameCharacters.test(next) || specialParameters.has(next);
};

// A word that starts with a real expansion. A lone `$` and an unclosed backtick are literal.
export const startsWithExpansion = (text: string): boolean => {
  if (text.startsWith('`')) {
    return text.includes('`', 1);
  }

  return text.startsWith('$') && startsExpansion(text, 0);
};

// A `$` that starts an expansion, or a closed backtick, anywhere in the text. A lone `$` and an
// unclosed backtick are literal.
const hasExpansionStart = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '$' && startsExpansion(text, index)) {
      return true;
    }

    if (text[index] === '`' && text.includes('`', index + 1)) {
      return true;
    }
  }

  return false;
};

// The `}` that closes the `${` opened at `start`, counting nested braces.
const matchingExpansionEnd = (word: string, start: number): number | undefined => {
  let depth = 0;

  for (let index = start + 2; index < word.length; index += 1) {
    if (word[index] === '{') {
      depth += 1;

      continue;
    }

    if (word[index] === '}') {
      if (depth === 0) {
        return index;
      }

      depth -= 1;
    }
  }

  return undefined;
};

// A parameter expansion whose body holds a `/` spans a path separator, so the slash is inside the
// expansion rather than a real separator. `${A:-b/c}` and `${A:-b/c}log` both count.
const hasSpanningParameterExpansion = (word: string): boolean => {
  let start = word.indexOf('${');

  while (start !== -1) {
    const end = matchingExpansionEnd(word, start);

    if (end !== undefined && word.slice(start + 2, end).includes('/')) {
      return true;
    }

    start = word.indexOf('${', start + 2);
  }

  return false;
};

// A trailing `}` is part of a parameter expansion only when it closes a `${` still open before it.
const closesOpenParameterExpansion = (word: string): boolean => {
  let open = 0;

  for (let index = 0; index < word.length - 1; index += 1) {
    if (word[index] === '$' && word[index + 1] === '{') {
      open += 1;
      index += 1;

      continue;
    }

    if (word[index] === '}' && open > 0) {
      open -= 1;
    }
  }

  return open > 0;
};

const endsWithOpenParameterExpansion = (word: string, lastSegment: string): boolean =>
  lastSegment.endsWith('}') && closesOpenParameterExpansion(word);

const endsWithParameterExpansion = (word: string, lastSegment: string): boolean =>
  hasSpanningParameterExpansion(word) || endsWithOpenParameterExpansion(word, lastSegment);

// A word a shell may rewrite from the environment when it sits in a deciding position. Only the last
// path segment counts for a variable or a backtick, because the shell resolves the directory part as
// a path. A parameter expansion that ends the word is the exception: it is checked across the whole
// word because its closing brace may sit in the last segment. A brace expansion anywhere in the
// word can rewrite a path segment, so it also counts.
export const isUnresolvedWord = (word: string): boolean => {
  if (isStructuralBrace(word)) {
    return false;
  }

  const lastSegment = commandNameOf(word);

  return (
    hasExpansionStart(lastSegment) ||
    endsWithParameterExpansion(word, lastSegment) ||
    isBraceExpansion(word)
  );
};

export const commandName = (word: string): string => commandNameOf(word).toLowerCase();

// An unquoted expansion anywhere in a word can split into more words. A variable in a directory
// segment of a command word cannot, because the shell resolves it as a path.
export const expandsAnywhere = (word: string): boolean =>
  hasExpansionStart(word) || isBraceExpansion(word);

const unresolvedGitWord = (words: readonly string[]): boolean => {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const value = optionValue(words, index, gitOptionValueNames);

    if (value !== undefined) {
      // An attached value is one argument, and an expansion in it can split into more words. A
      // separate value stays data, so shell code such as `git -C "$DIR" log` allows.
      if (value.next === index + 1 && expandsAnywhere(value.value)) {
        return true;
      }

      index = value.next - 1;

      continue;
    }

    if (expandsAnywhere(word)) {
      return true;
    }

    if (!word.startsWith('-')) {
      return false;
    }
  }

  return false;
};

// Only shell code runs a variable as a word. A candidate script may be data, and the tool command
// is checked by the literal scan, so neither blocks here.
export const blocksUnresolvedDecidingWord = (
  origin: TextOrigin,
  commandWord: string | undefined,
  laterWords: readonly string[],
): boolean => {
  if (origin.kind !== 'shellCode' || commandWord === undefined) {
    return false;
  }

  if (isUnresolvedWord(commandWord)) {
    return true;
  }

  return commandName(commandWord) === 'git' && unresolvedGitWord(laterWords);
};
