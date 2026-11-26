import { expect } from 'vitest';

import type {
  launchPiSession,
  launchPiSessionRightOf,
  startPiSession,
} from '../src/piStart/piStart.js';
import type { ExecFake } from './execFake.js';
import { foregroundReaderFor } from './herdrAppFake.js';

export type ForegroundReader = (
  terminal: string,
  signal: AbortSignal,
) => Promise<readonly string[] | undefined>;

type StartRequest = Parameters<typeof startPiSession>[1];
type LaunchRequest = Parameters<typeof launchPiSession>[1];
type PaneRequest = Parameters<typeof launchPiSessionRightOf>[1];
type CommonRequest = Omit<StartRequest, 'target' | 'tabName'>;

export const readerFor = <Key extends string>(
  fake: ExecFake<Key>,
  root: string,
): ForegroundReader => foregroundReaderFor({ exec: fake.exec, cwd: root });

export const readbackCall = (terminal: string): Record<string, unknown> => ({
  command: 'hc',
  commandArguments: ['get', '--json', '--', terminal],
  signal: expect.any(AbortSignal),
});

const commonRequest = (root: string, readForegroundArgv: ForegroundReader): CommonRequest => ({
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
  readForegroundArgv: ForegroundReader,
  overrides: Partial<StartRequest> = {},
): StartRequest => ({
  ...commonRequest(root, readForegroundArgv),
  target: { space: 'space-1' },
  tabName: 'lead',
  ...overrides,
});

export const launchRequest = (
  root: string,
  readForegroundArgv: ForegroundReader,
): LaunchRequest => ({
  ...commonRequest(root, readForegroundArgv),
  target: { name: 'ticket-1' },
  tabName: 'architect',
});

export const paneRequest = (root: string, readForegroundArgv: ForegroundReader): PaneRequest => ({
  ...commonRequest(root, readForegroundArgv),
  pane: 'p-lead',
  task: 'Design this',
});
