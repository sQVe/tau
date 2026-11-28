import { expect } from 'vitest';

import { foregroundArgv } from '../src/hc/hc.js';
import type {
  launchPiSession,
  launchPiSessionRightOf,
  startPiSession,
} from '../src/piStart/piStart.js';
import type { ReadForegroundArgv } from '../src/piStart/startedModel/startedModelReadback.js';
import type { ExecCall, ExecFake } from './execFake.js';

type StartRequest = Parameters<typeof startPiSession>[1];
type LaunchRequest = Parameters<typeof launchPiSession>[1];
type PaneRequest = Parameters<typeof launchPiSessionRightOf>[1];
type CommonRequest = Omit<StartRequest, 'target' | 'tabName'>;

export const readerFor =
  <Key extends string>(fake: ExecFake<Key>, root: string): ReadForegroundArgv =>
  (terminal, signal) =>
    foregroundArgv({ exec: fake.exec, cwd: root, signal }, terminal);

// The matcher stands for any AbortSignal, so the recorded call keeps its signal type.
const anyAbortSignal = (): AbortSignal => expect.any(AbortSignal) as AbortSignal;

export const readbackCall = (terminal: string): ExecCall => ({
  command: 'hc',
  commandArguments: ['get', '--json', '--', terminal],
  signal: anyAbortSignal(),
});

const commonRequest = (root: string, readForegroundArgv: ReadForegroundArgv): CommonRequest => ({
  folder: root,
  task: 'Next steps\n',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
});

export const startRequest = (
  root: string,
  readForegroundArgv: ReadForegroundArgv,
  overrides: Partial<StartRequest> = {},
): StartRequest => ({
  ...commonRequest(root, readForegroundArgv),
  target: { space: 'space-1' },
  tabName: 'lead',
  ...overrides,
});

export const launchRequest = (
  root: string,
  readForegroundArgv: ReadForegroundArgv,
): LaunchRequest => ({
  ...commonRequest(root, readForegroundArgv),
  target: { name: 'ticket-1' },
  tabName: 'architect',
});

export const paneRequest = (root: string, readForegroundArgv: ReadForegroundArgv): PaneRequest => ({
  ...commonRequest(root, readForegroundArgv),
  pane: 'p-lead',
  task: 'Design this',
});
