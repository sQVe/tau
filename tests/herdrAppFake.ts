import { createExecFake, succeededResult } from './execFake.js';
import type { ExecFake } from './execFake.js';

export type HerdrAppCommand =
  | 'ls'
  | 'pane.close'
  | 'pane.split'
  | 'pane.swap'
  | 'space.new'
  | 'tab.new';

export interface HerdrAppReplies {
  // The reply to `herdr-app ls`. Defaults to a layout with no spaces.
  layout?: string;
  // The reply to `herdr-app do pane.split`. Defaults to pane p-new in terminal t-new.
  split?: string;
  // Runs before the reply, so a test can inject a fault such as a cancellation.
  beforeReply?: (key: HerdrAppCommand) => void;
}

const emptyLayout = JSON.stringify({ spaces: [] });
const defaultSplit = JSON.stringify({ pane: 'p-new', terminal: 't-new' });

const commands = new Set<HerdrAppCommand>([
  'ls',
  'pane.close',
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
