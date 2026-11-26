import type { CommandRuntime, Exec } from '../src/command.js';
import { foregroundArgv } from '../src/hc/hc.js';
import type { HerdrSpace } from '../src/piStart/herdrPane.js';
import {
  argumentAfter,
  createExecFake,
  failedResult,
  isCommandOf,
  succeededResult,
} from './execFake.js';
import type { ExecCall, ExecFake } from './execFake.js';

export type HerdrAppCommand = 'ls' | 'pane.split' | 'space.new' | 'tab.new';

type LaunchCommand = Extract<HerdrAppCommand, 'space.new' | 'tab.new'>;

type HerdrAppSpace = Omit<HerdrSpace, 'machine'> & { machine?: string | null };

export interface HerdrAppFakeOptions {
  beforeReply?: (key: HerdrAppCommand) => void;
  spaces?: readonly HerdrAppSpace[];
}

// The reader a piStart request takes, so a test never imports the hc module from src/piStart.
export const foregroundReaderFor =
  (
    runtime: CommandRuntime,
  ): ((terminal: string, signal: AbortSignal) => Promise<readonly string[] | undefined>) =>
  (terminal, signal) =>
    foregroundArgv({ ...runtime, signal }, terminal);

export const listedSpace = (
  id: string,
  name: string,
  folder: string,
  machine: string | null = null,
): HerdrSpace => ({ id, name, folder, machine });

const launchReply = (space: string): string =>
  JSON.stringify({ space, tab: 'tb-new', terminal: 't-new' });

const defaultLaunch = launchReply('sp-new');
const defaultSplit = JSON.stringify({ pane: 'p-new', terminal: 't-new' });

const commands = new Set<HerdrAppCommand>(['ls', 'pane.split', 'space.new', 'tab.new']);

const isHerdrAppCommand = (value: string | undefined): value is HerdrAppCommand =>
  isCommandOf(commands, value);

const commandOf = (
  command: string,
  commandArguments: readonly string[],
): HerdrAppCommand | undefined => {
  if (command !== 'herdr-app') {
    return undefined;
  }

  const [action, name] = commandArguments;

  if (action === 'ls') {
    return 'ls';
  }

  if (action !== 'do') {
    return undefined;
  }

  return isHerdrAppCommand(name) ? name : undefined;
};

// The listing is one document for both readers, so a listed space carries the tabs findPane reads.
const listedSpaces = (spaces: HerdrAppFakeOptions['spaces']) =>
  (spaces ?? []).map((space) => ({
    id: space.id,
    name: space.name,
    folder: space.folder,
    machine: space.machine ?? null,
    tabs: [],
  }));

const tabReply = (commandArguments: readonly string[]): string => {
  const space = argumentAfter(commandArguments, '--space');

  if (space === undefined) {
    throw new Error('tab.new needs --space');
  }

  if (space.startsWith('--')) {
    throw new Error(`tab.new --space needs a value, got the flag ${space}`);
  }

  return launchReply(space);
};

const replyFor = (
  key: HerdrAppCommand,
  commandArguments: readonly string[],
  spaces: HerdrAppFakeOptions['spaces'],
): string => {
  switch (key) {
    case 'ls':
      return JSON.stringify({ spaces: listedSpaces(spaces) });
    case 'pane.split':
      return defaultSplit;
    case 'space.new':
      return defaultLaunch;
    case 'tab.new':
      return tabReply(commandArguments);
    default:
      throw new Error(`no fake reply for ${String(key)}`);
  }
};

export const terminalFromReply = (stdout: string): string | undefined => {
  try {
    const value = JSON.parse(stdout) as { terminal?: unknown };

    return typeof value.terminal === 'string' ? value.terminal : undefined;
  } catch {
    return undefined;
  }
};

const foregroundFromLaunch = (
  commandArguments: readonly string[],
): {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
} => {
  const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];
  const provider = argumentAfter(argv, '--provider');
  const model = argumentAfter(argv, '--model');

  const modelArguments = [
    ...(provider === undefined ? [] : ['--provider', provider]),
    ...(model === undefined ? [] : ['--model', model]),
  ];

  return { pid: 1, name: 'pi', argv: ['pi', ...modelArguments], cwd: '' };
};

type StartedForeground = ReturnType<typeof foregroundFromLaunch>;

const foregroundReply = (address: string, foreground: StartedForeground): string =>
  JSON.stringify({ address, state: 'live', foreground });

// The one reply shape for a terminal this fake started, so a reader and the hc get schema agree.
export const launchedTerminalReply = (
  address: string,
  commandArguments: readonly string[],
): string => foregroundReply(address, foregroundFromLaunch(commandArguments));

const getKey = 'get';

// hc's exit code when it cannot find the terminal, which this fake shares with the CLI.
const notFoundExitCode = 3;

type HerdrAppKey = HerdrAppCommand | typeof getKey;

export const createHerdrAppFake = (
  options: HerdrAppFakeOptions = {},
): ExecFake<HerdrAppCommand> => {
  const startedForegrounds = new Map<string, StartedForeground>();

  const execFake = createExecFake<HerdrAppKey>({
    keyOf: (command, commandArguments) =>
      command === 'hc' && commandArguments[0] === getKey
        ? getKey
        : commandOf(command, commandArguments),
    handlerFor: (key) => {
      if (key === getKey) {
        return (commandArguments) => {
          const address = commandArguments.at(-1) ?? '';
          const foreground = startedForegrounds.get(address);

          return foreground === undefined
            ? failedResult(
                JSON.stringify({
                  error: { kind: 'not_found', message: `unknown terminal: ${address}` },
                }),
                notFoundExitCode,
              )
            : succeededResult(foregroundReply(address, foreground));
        };
      }

      return (commandArguments) => {
        options.beforeReply?.(key);

        return succeededResult(replyFor(key, commandArguments, options.spaces));
      };
    },
  });

  const exec: Exec = async (command, commandArguments, execOptions) => {
    const result = await execFake.exec(command, commandArguments, execOptions);

    if (result.code === 0 && command === 'herdr-app') {
      const terminal = terminalFromReply(result.stdout);

      if (terminal !== undefined && argumentAfter(commandArguments, '--argv') !== undefined) {
        startedForegrounds.set(terminal, foregroundFromLaunch(commandArguments));
      }
    }

    return result;
  };

  return { ...execFake, exec };
};

const launchCommands = new Set<LaunchCommand>(['space.new', 'tab.new']);

const isLaunchCommand = (value: string | undefined): value is LaunchCommand =>
  isCommandOf(launchCommands, value);

export const commandArgumentsOf = (calls: readonly ExecCall[]): string[][] =>
  calls.map(({ commandArguments }) => commandArguments);

export const spaceOrTabLaunchesOf = (fake: ExecFake<HerdrAppCommand>): ExecCall[] =>
  fake.calls.filter(
    ({ commandArguments }) => commandArguments[0] === 'do' && isLaunchCommand(commandArguments[1]),
  );
