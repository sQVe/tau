import { parseShellCommands } from '../../shell.js';

const shellRunnerNames = new Set(['bash', 'dash', 'sh', 'zsh']);
const typingSubcommands = new Set(['keys', 'send']);
const helpOptions = new Set(['--help', '-h']);
const assignmentPattern = /^[A-Za-z_]\w*=/;
const commandKeywords = new Set(['!', '{', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);

const startsCommand = (word: string) => assignmentPattern.test(word) || commandKeywords.has(word);

const commandName = (word: string) => word.slice(word.lastIndexOf('/') + 1);

const commandWordsOf = (words: string[]) => {
  const start = words.findIndex((word) => !startsCommand(word));

  return start === -1 ? [] : words.slice(start);
};

const asksHelp = (commandArguments: string[]) => {
  const delimiterIndex = commandArguments.indexOf('--');

  const options =
    delimiterIndex === -1 ? commandArguments : commandArguments.slice(0, delimiterIndex);

  return options.some((word) => helpOptions.has(word));
};

const runsHcTyping = ([name, ...rest]: string[]) => {
  const subcommandIndex = rest.findIndex((word) => !word.startsWith('-'));
  const runsHc = name !== undefined && commandName(name) === 'hc';

  const typesText = typingSubcommands.has(rest[subcommandIndex] ?? '');

  return runsHc && typesText && !asksHelp(rest.slice(subcommandIndex + 1));
};

const shellScriptOf = ([name, ...rest]: string[]) => {
  const optionIndex = rest.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
  const runsShell = name !== undefined && shellRunnerNames.has(commandName(name));

  return runsShell && optionIndex !== -1 ? rest[optionIndex + 1] : undefined;
};

export const typesIntoTerminal = (source: string): boolean =>
  (parseShellCommands(source) ?? []).some((command) => {
    const commandWords = commandWordsOf(command.arguments);

    if (runsHcTyping(commandWords)) {
      return true;
    }

    const script = shellScriptOf(commandWords);

    return script !== undefined && typesIntoTerminal(script);
  });
