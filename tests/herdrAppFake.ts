import { argumentAfter, createExecFake, succeededResult } from './execFake.js';
import type { ExecFake } from './execFake.js';

export type HerdrAppCommand = 'ls' | 'pane.split' | 'pane.swap' | 'space.new' | 'tab.new';

export interface HerdrAppFakeOptions {
  beforeReply?: (key: HerdrAppCommand) => void;
  spaces?: readonly { id: string; name: string; folder: string; machine?: string | null }[];
}

const defaultLaunch = JSON.stringify({ space: 'sp-new', tab: 'tb-new', terminal: 't-new' });
const defaultSplit = JSON.stringify({ pane: 'p-new', terminal: 't-new' });

const commands = new Set<HerdrAppCommand>([
  'ls',
  'pane.split',
  'pane.swap',
  'space.new',
  'tab.new',
]);

const isHerdrAppCommand = (value: string | undefined): value is HerdrAppCommand =>
  value !== undefined && commands.has(value as HerdrAppCommand);

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

const replyFor = (
  key: HerdrAppCommand,
  commandArguments: readonly string[],
  spaces: HerdrAppFakeOptions['spaces'],
): string => {
  if (key === 'ls') {
    const listed = (spaces ?? []).map((space) => ({
      id: space.id,
      name: space.name,
      folder: space.folder,
      machine: space.machine ?? null,
    }));

    return JSON.stringify({ spaces: listed });
  }

  if (key === 'pane.split') {
    return defaultSplit;
  }

  if (key === 'tab.new') {
    const space = argumentAfter(commandArguments, '--space') ?? 'sp-new';

    return JSON.stringify({ space, tab: 'tb-new', terminal: 't-new' });
  }

  return defaultLaunch;
};

export const createHerdrAppFake = (options: HerdrAppFakeOptions = {}): ExecFake<HerdrAppCommand> =>
  createExecFake<HerdrAppCommand>({
    keyOf: commandOf,
    handlerFor: (key) => (commandArguments) => {
      options.beforeReply?.(key);

      return succeededResult(replyFor(key, commandArguments, options.spaces));
    },
  });
