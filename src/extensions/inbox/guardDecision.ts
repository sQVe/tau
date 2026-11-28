import { parseShellCommands } from '../../shell/shell.js';
import { shellScriptOf } from '../../shell/shellScript.js';
import { commandNameOf, commandWords } from '../../wrapperAnalysis.js';

const typingSubcommands = new Set(['keys', 'send']);
const helpOptions = new Set(['--help', '-h']);

const asksHelp = (commandArguments: string[]) => {
  const delimiterIndex = commandArguments.indexOf('--');

  const options =
    delimiterIndex === -1 ? commandArguments : commandArguments.slice(0, delimiterIndex);

  return options.some((word) => helpOptions.has(word));
};

const runsHcTyping = ([name, ...rest]: readonly string[]) => {
  const subcommandIndex = rest.findIndex((word) => !word.startsWith('-'));
  const runsHc = name !== undefined && commandNameOf(name) === 'hc';

  const typesText = typingSubcommands.has(rest[subcommandIndex] ?? '');

  return runsHc && typesText && !asksHelp(rest.slice(subcommandIndex + 1));
};

const runsTypingCommand = (words: readonly string[]): boolean => {
  const command = commandWords(words);

  // A lookup names a command instead of running it, so an unreadable value after it runs nothing.
  if (command.lookup) {
    return false;
  }

  // An unreadable `env -S` value may still run a typing command, so the guard fails closed.
  if (command.unreadable) {
    return true;
  }

  return runsHcTyping(command.words);
};

export const typesIntoTerminal = (source: string): boolean =>
  (parseShellCommands(source) ?? []).some((command) => {
    if (runsTypingCommand(command.arguments)) {
      return true;
    }

    const shellScript = shellScriptOf(command.arguments);

    return shellScript.kind === 'script' && typesIntoTerminal(shellScript.script);
  });
