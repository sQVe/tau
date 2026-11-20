import { createExecFake, succeededResult } from './execFake.js';
import type { ExecFake } from './execFake.js';

export type HerdrAppCommand = 'ls' | 'pane.split' | 'pane.swap' | 'space.new' | 'tab.new';

export interface HerdrAppReplies {
  layout?: string;
  split?: string;
  beforeReply?: (key: HerdrAppCommand) => void;
}

const emptyLayout = JSON.stringify({ spaces: [] });
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

const replyFor = (key: HerdrAppCommand, replies: HerdrAppReplies): string => {
  if (key === 'ls') {
    return replies.layout ?? emptyLayout;
  }

  if (key === 'pane.split') {
    return replies.split ?? defaultSplit;
  }

  return '{"ok":true}';
};

export const createHerdrAppFake = (replies: HerdrAppReplies = {}): ExecFake<HerdrAppCommand> =>
  createExecFake<HerdrAppCommand>({
    keyOf: commandOf,
    handlerFor: (key) => () => {
      replies.beforeReply?.(key);

      return succeededResult(replyFor(key, replies));
    },
  });
