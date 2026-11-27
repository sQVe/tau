import { parseShellCommands } from '../../shell.js';
import { shellScriptOf } from '../../shellScript.js';
import { commandNameOf, commandWords } from '../../wrapperAnalysis.js';

const typingSubcommands = new Set(['keys', 'send']);
const helpOptions = new Set(['--help', '-h']);

const asksHelp = (commandArguments: string[]) => {
  const delimiterIndex = commandArguments.indexOf('--');

  const options =
    delimiterIndex === -1 ? commandArguments : commandArguments.slice(0, delimiterIndex);

  return options.some((word) => helpOptions.has(word));
};

const runsHcTyping = ([name, ...rest]: string[]) => {
  const subcommandIndex = rest.findIndex((word) => !word.startsWith('-'));
  const runsHc = name !== undefined && commandNameOf(name) === 'hc';

  const typesText = typingSubcommands.has(rest[subcommandIndex] ?? '');

  return runsHc && typesText && !asksHelp(rest.slice(subcommandIndex + 1));
};

const commandWordsOf = (words: string[]): string[] => {
  const command = commandWords(words);

  return command.lookup ? [] : [...command.words];
};

export const typesIntoTerminal = (source: string): boolean =>
  (parseShellCommands(source) ?? []).some((command) => {
    const words = commandWordsOf(command.arguments);

    if (runsHcTyping(words)) {
      return true;
    }

    const script = shellScriptOf(command.arguments);

    return script !== undefined && typesIntoTerminal(script);
  });
