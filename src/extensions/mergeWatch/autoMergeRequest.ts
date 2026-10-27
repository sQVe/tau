export interface AutoMergeRequest {
  selector: string | undefined;
  repository: string | undefined;
}

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

const mergeArguments = (words: string[]): string[] | undefined => {
  const start = words.findIndex((word) => !isCommandPrefix(word));
  const executable = words.slice(start, start + mergeCommand.length);

  const runsMerge =
    start !== -1 && mergeCommand.every((word, offset) => executable[offset] === word);

  return runsMerge ? words.slice(start + mergeCommand.length) : undefined;
};

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
