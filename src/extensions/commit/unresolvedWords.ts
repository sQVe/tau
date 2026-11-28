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

// A variable or a backtick can rewrite the word from the environment.
const hasVariableMarker = (text: string): boolean => /[$`]/u.test(text);

const hasBraceCharacter = (text: string): boolean => text.includes('{') || text.includes('}');

// A word a shell may rewrite from the environment when it sits in a deciding position. Only the last
// path segment counts for a variable or a backtick, because the shell resolves the directory part as
// a path. A brace expansion anywhere in the word can rewrite a path segment, so it also counts.
export const isUnresolvedWord = (word: string): boolean => {
  if (isStructuralBrace(word)) {
    return false;
  }

  const lastSegment = word.slice(word.lastIndexOf('/') + 1);

  return hasVariableMarker(lastSegment) || hasBraceCharacter(lastSegment) || isBraceExpansion(word);
};

export const commandName = (word: string): string =>
  word.slice(word.lastIndexOf('/') + 1).toLowerCase();

// An unquoted expansion anywhere in a word can split into more words. A variable in a directory
// segment of a command word cannot, because the shell resolves it as a path.
export const expandsAnywhere = (word: string): boolean =>
  hasVariableMarker(word) || isBraceExpansion(word);

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
