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

// The value attached to a known Git option, such as `/repo` in `--git-dir=/repo` or `-C/repo`.
const attachedGitOptionValue = (word: string): string | undefined => {
  if (word.startsWith('--')) {
    const equals = word.indexOf('=');
    const name = equals === -1 ? undefined : word.slice(0, equals);

    return name !== undefined && gitOptionValueNames.has(name) ? word.slice(equals + 1) : undefined;
  }

  const option = [...gitOptionValueNames].find(
    (candidate) => !candidate.startsWith('--') && word !== candidate && word.startsWith(candidate),
  );

  return option === undefined ? undefined : word.slice(option.length);
};

// A brace expansion starts with a `{` that is not part of a parameter expansion, which begins with
// `${`. A lone brace is a structural token, not a value.
const isBraceExpansion = (word: string): boolean => /(?<!\$)\{/u.test(word) && word.includes('}');

const isStructuralBrace = (word: string): boolean => word === '}' || word === '{';

// A word a shell may rewrite from the environment when it sits in a deciding position. Only the last
// path segment counts for a variable or a backtick, because the shell resolves the directory part as
// a path. A brace expansion anywhere in the word can rewrite a path segment, so it also counts.
export const isUnresolvedWord = (word: string): boolean => {
  if (isStructuralBrace(word)) {
    return false;
  }

  const lastSegment = word.slice(word.lastIndexOf('/') + 1);

  return /[$`{}]/u.test(lastSegment) || isBraceExpansion(word);
};

// The last path segment of a command word, lowercased, as a shell resolves the directory part.
export const commandName = (word: string): string =>
  word.slice(word.lastIndexOf('/') + 1).toLowerCase();

const unresolvedGitWord = (words: readonly string[]): boolean => {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (gitOptionValueNames.has(word)) {
      index += 1;

      continue;
    }

    const attachedValue = attachedGitOptionValue(word);

    // An attached value stays one argument only when nothing in it can expand. An unquoted
    // expansion can split into more words, and one of them can be the subcommand. The parser drops
    // quotes, so a quoted value is blocked too; that false block is the cost of closing the bypass.
    if (attachedValue !== undefined && !isUnresolvedWord(attachedValue)) {
      continue;
    }

    if (isUnresolvedWord(word)) {
      return true;
    }

    if (!word.startsWith('-')) {
      return false;
    }
  }

  return false;
};

// The words after a `git` command word up to its subcommand. An unresolved word before the
// subcommand, or in the subcommand slot itself, may decide which Git subcommand runs. A value Git
// takes as data, such as the directory after `-C`, is never the subcommand.
export const unresolvedGitWordBeforeSubcommand = (
  words: readonly string[],
  gitIndex: number,
): boolean => unresolvedGitWord(words.slice(gitIndex + 1));

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
