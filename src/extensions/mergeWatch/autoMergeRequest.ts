// Finds the gh pr merge --auto calls in a bash command at the level of words. Quotes keep spaces and
// separators inside one word; other shell syntax is not parsed. tests/structure.test.ts keeps this
// module pure.

export interface AutoMergeRequest {
  // The pull request argument, or undefined for the current branch.
  selector: string | undefined;
  repository: string | undefined;
}

// A token is a separator outside quotes or a word whose quoted parts may hold spaces and separators.
const tokenPattern = /&&|\|\||[;|&\n]|(?:"[^"]*"|'[^']*'|[^\s"';|&])+/gu;
const separatorPattern = /^(?:&&|\|\||[;|&\n])$/u;
const assignmentPattern = /^[A-Za-z_]\w*=/u;
const commandWrappers = new Set(['command', 'env', 'exec', 'nohup', 'time']);
const repositoryFlags = new Set(['-R', '--repo']);

const valueFlags = new Set([
  ...repositoryFlags,
  '-A',
  '--author-email',
  '-b',
  '--body',
  '-F',
  '--body-file',
  '--match-head-commit',
  '-t',
  '--subject',
]);

const unquote = (word: string) => word.replaceAll(/"([^"]*)"|'([^']*)'/gu, '$1$2');

// Splits a command into simple commands, each a list of unquoted words.
const simpleCommands = (command: string): string[][] => {
  const commands: string[][] = [[]];

  for (const token of command.match(tokenPattern) ?? []) {
    if (separatorPattern.test(token)) {
      commands.push([]);
    } else {
      commands.at(-1)?.push(unquote(token));
    }
  }

  return commands;
};

const isCommandPrefix = (word: string) => assignmentPattern.test(word) || commandWrappers.has(word);

const mergeCommand = ['gh', 'pr', 'merge'];

// Returns the arguments of gh pr merge when gh is the executable, after assignments and wrappers.
const mergeArguments = (words: string[]): string[] | undefined => {
  const start = words.findIndex((word) => !isCommandPrefix(word));
  const executable = words.slice(start, start + mergeCommand.length);

  const runsMerge =
    start !== -1 && mergeCommand.every((word, offset) => executable[offset] === word);

  return runsMerge ? words.slice(start + mergeCommand.length) : undefined;
};

// Splits --flag=value into two words, so a flag reads its value the same way in both forms.
const splitInlineValues = (words: string[]) =>
  words.flatMap((word) => {
    const separator = word.indexOf('=');

    return word.startsWith('--') && separator !== -1
      ? [word.slice(0, separator), word.slice(separator + 1)]
      : [word];
  });

const readRequest = (commandArguments: string[]): AutoMergeRequest | undefined => {
  const words = splitInlineValues(commandArguments);
  let selector: string | undefined;
  let repository: string | undefined;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (repositoryFlags.has(word)) {
      repository = words[index + 1];
    }

    if (valueFlags.has(word)) {
      index += 1;
    } else if (!word.startsWith('-')) {
      selector ??= word;
    }
  }

  return words.includes('--auto') ? { selector, repository } : undefined;
};

export const parseAutoMergeRequests = (command: string): AutoMergeRequest[] =>
  simpleCommands(command).flatMap((words) => {
    const commandArguments = mergeArguments(words);
    const request = commandArguments === undefined ? undefined : readRequest(commandArguments);

    return request === undefined ? [] : [request];
  });
