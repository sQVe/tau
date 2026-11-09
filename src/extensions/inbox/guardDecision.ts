import { parseShellCommands } from '../../shell.js';

const shellRunnerNames = new Set(['bash', 'dash', 'sh', 'zsh']);
const typingSubcommands = new Set(['keys', 'send']);
const helpOptions = new Set(['--help', '-h']);
const assignmentPattern = /^[A-Za-z_]\w*=/;
const commandKeywords = new Set(['!', '{', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);

// Each wrapper runs the command after its options. The set lists the options that take the next
// word as their value.
const wrapperValueOptions = new Map<string, Set<string>>([
  ['command', new Set()],
  ['env', new Set(['-C', '-u', '--chdir', '--unset'])],
  ['exec', new Set(['-a'])],
  ['nohup', new Set()],
  [
    'sudo',
    new Set([
      '-C',
      '-D',
      '-g',
      '-h',
      '-p',
      '-R',
      '-r',
      '-T',
      '-t',
      '-U',
      '-u',
      '--chdir',
      '--chroot',
      '--close-from',
      '--command-timeout',
      '--group',
      '--host',
      '--login-class',
      '--other-user',
      '--prompt',
      '--role',
      '--type',
      '--user',
    ]),
  ],
  ['time', new Set(['-f', '-o', '--format', '--output'])],
  [
    'xargs',
    new Set([
      '-a',
      '-d',
      '-E',
      '-I',
      '-L',
      '-n',
      '-P',
      '-s',
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-chars',
      '--max-procs',
    ]),
  ],
]);

// `command -v` and `command -V`, also combined with `-p`, describe the command instead of running
// it.
const lookupOptionPattern = /^-p*[vV][pvV]*$/u;

const startsCommand = (word: string) => assignmentPattern.test(word) || commandKeywords.has(word);

const commandName = (word: string) => word.slice(word.lastIndexOf('/') + 1);

const wrappedCommandIndex = (words: string[], start: number, valueOptions: Set<string>) => {
  let index = start;

  while (index < words.length) {
    const word = words[index] ?? '';

    if (!word.startsWith('-')) {
      return index;
    }

    index += valueOptions.has(word) ? 2 : 1;
  }

  return index;
};

const looksUpCommand = (name: string, options: string[]) =>
  name === 'command' && options.some((word) => lookupOptionPattern.test(word));

const commandWordsOf = (words: string[]): string[] => {
  let index = 0;

  while (index < words.length) {
    const word = words[index] ?? '';
    const name = commandName(word);
    const valueOptions = wrapperValueOptions.get(name);

    if (startsCommand(word)) {
      index += 1;
    } else if (valueOptions === undefined) {
      return words.slice(index);
    } else {
      const wrappedIndex = wrappedCommandIndex(words, index + 1, valueOptions);

      if (looksUpCommand(name, words.slice(index + 1, wrappedIndex))) {
        return [];
      }

      index = wrappedIndex;
    }
  }

  return [];
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
