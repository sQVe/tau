import type { Exec } from '../src/command.js';
import type { HcTerminal } from '../src/hc/replies.js';
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

type StartedForeground = NonNullable<HcTerminal['foreground']>;

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

// Every launch answers with the same terminal, `t-new`, so the fake models one terminal at a time.
// A test that needs two live terminals must override the reply.
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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

// The launch arguments carry the started argv as JSON. A malformed value is a test mistake, so this
// reader refuses it instead of reporting a terminal with no foreground.
const launchArgv = (commandArguments: readonly string[]): string[] | undefined => {
  const value = argumentAfter(commandArguments, '--argv');

  if (value === undefined) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`herdr-app fake received malformed --argv JSON: ${value}`, { cause: error });
  }

  if (!isStringArray(parsed)) {
    throw new Error(`herdr-app fake received a --argv that is not a list of strings: ${value}`);
  }

  return parsed;
};

// The fake reports a normalized foreground that keeps only the model flags, because the real launch
// wraps Pi in `env` and the readback matches a Pi argv. `foreground.argv` is therefore not the
// launched argv; `fake.calls` holds that.
const startedForegroundOf = (
  commandArguments: readonly string[],
): StartedForeground | undefined => {
  const argv = launchArgv(commandArguments);

  if (argv === undefined) {
    return undefined;
  }

  const provider = argumentAfter(argv, '--provider');
  const model = argumentAfter(argv, '--model');
  const modelArguments: string[] = [];

  if (provider !== undefined) {
    modelArguments.push('--provider', provider);
  }

  if (model !== undefined) {
    modelArguments.push('--model', model);
  }

  const cwd = argumentAfter(commandArguments, '--folder') ?? argumentAfter(argv, '-C');

  if (cwd === undefined || cwd.startsWith('--')) {
    throw new Error('herdr-app fake received a launch without --folder or -C');
  }

  return { pid: 1, name: 'pi', argv: ['pi', ...modelArguments], cwd };
};

const liveReply = (address: string, foreground: StartedForeground | undefined): string => {
  const reply =
    foreground === undefined ? { address, state: 'live' } : { address, state: 'live', foreground };

  return JSON.stringify(reply);
};

// The one reply shape for a terminal this fake started, so a reader and the hc get schema agree.
export const launchedTerminalReply = (
  address: string,
  commandArguments: readonly string[],
): string => liveReply(address, startedForegroundOf(commandArguments));

const getKey = 'get';

// hc's exit code when it cannot find the terminal, which this fake shares with the CLI.
const notFoundExitCode = 3;

export type HerdrAppKey = HerdrAppCommand | typeof getKey;

export const createHerdrAppFake = (options: HerdrAppFakeOptions = {}): ExecFake<HerdrAppKey> => {
  const startedForegrounds = new Map<string, StartedForeground>();
  const startedTerminals = new Set<string>();

  const execFake = createExecFake<HerdrAppKey>({
    keyOf: (command, commandArguments) =>
      command === 'hc' && commandArguments[0] === getKey
        ? getKey
        : commandOf(command, commandArguments),
    handlerFor: (key) => {
      if (key === getKey) {
        return (commandArguments) => {
          const delimiter = commandArguments.indexOf('--');

          const address =
            delimiter === -1 ? commandArguments.at(-1) : commandArguments[delimiter + 1];

          if (address === undefined || address === '') {
            throw new Error('hc get needs a terminal address');
          }

          const foreground = startedForegrounds.get(address);

          if (foreground !== undefined) {
            return succeededResult(liveReply(address, foreground));
          }

          // A terminal this fake started but recorded no argv for is live with no foreground yet.
          if (startedTerminals.has(address)) {
            return succeededResult(liveReply(address, undefined));
          }

          return failedResult(
            JSON.stringify({
              error: { kind: 'not_found', message: `unknown terminal: ${address}` },
            }),
            notFoundExitCode,
          );
        };
      }

      return (commandArguments) => {
        options.beforeReply?.(key);

        return succeededResult(replyFor(key, commandArguments, options.spaces));
      };
    },
  });

  const exec: Exec = async (command, commandArguments, execOptions) => {
    // Resolve a malformed launch before the inner fake records it, so a test mistake fails at the
    // fake boundary without a half-applied launch.
    const launchForeground =
      command === 'herdr-app' ? startedForegroundOf(commandArguments) : undefined;

    const result = await execFake.exec(command, commandArguments, execOptions);

    if (result.code === 0 && command === 'herdr-app') {
      const terminal = terminalFromReply(result.stdout);

      if (terminal !== undefined) {
        const foreground = launchForeground;

        startedTerminals.add(terminal);

        if (foreground === undefined) {
          startedForegrounds.delete(terminal);
        } else {
          startedForegrounds.set(terminal, foreground);
        }
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
