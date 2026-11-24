import type { HerdrSpace } from '../src/piStart/herdrPane.js';
import { argumentAfter, createExecFake, isCommandOf, succeededResult } from './execFake.js';
import type { ExecCall, ExecFake } from './execFake.js';

export type HerdrAppCommand = 'ls' | 'pane.split' | 'space.new' | 'tab.new';

type LaunchCommand = Extract<HerdrAppCommand, 'space.new' | 'tab.new'>;

type HerdrAppSpace = Omit<HerdrSpace, 'machine'> & { machine?: string | null };

export interface HerdrAppFakeOptions {
  beforeReply?: (key: HerdrAppCommand) => void;
  spaces?: readonly HerdrAppSpace[];
}

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

export const createHerdrAppFake = (options: HerdrAppFakeOptions = {}): ExecFake<HerdrAppCommand> =>
  createExecFake<HerdrAppCommand>({
    keyOf: commandOf,
    handlerFor: (key) => (commandArguments) => {
      options.beforeReply?.(key);

      return succeededResult(replyFor(key, commandArguments, options.spaces));
    },
  });

const launchCommands = new Set<LaunchCommand>(['space.new', 'tab.new']);

const isLaunchCommand = (value: string | undefined): value is LaunchCommand =>
  isCommandOf(launchCommands, value);

export const commandArgumentsOf = (calls: readonly ExecCall[]): string[][] =>
  calls.map(({ commandArguments }) => commandArguments);

export const spaceOrTabLaunchesOf = (fake: ExecFake<HerdrAppCommand>): ExecCall[] =>
  fake.calls.filter(
    ({ commandArguments }) => commandArguments[0] === 'do' && isLaunchCommand(commandArguments[1]),
  );
