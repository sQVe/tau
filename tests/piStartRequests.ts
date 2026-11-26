import type {
  launchPiSession,
  launchPiSessionRightOf,
  startPiSession,
} from '../src/piStart/piStart.js';
import type { ExecFake } from './execFake.js';
import { foregroundReaderFor } from './herdrAppFake.js';

export type ForegroundReader = (terminal: string) => Promise<readonly string[] | undefined>;

export const readerFor = <Key extends string>(
  fake: ExecFake<Key>,
  root: string,
): ForegroundReader => foregroundReaderFor({ exec: fake.exec, cwd: root });

export const startRequest = (
  root: string,
  readForegroundArgv: ForegroundReader,
  overrides: Partial<Parameters<typeof startPiSession>[1]> = {},
): Parameters<typeof startPiSession>[1] => ({
  folder: root,
  target: { space: 'space-1' },
  tabName: 'lead',
  task: 'Next steps\n',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
  ...overrides,
});

export const launchRequest = (
  root: string,
  readForegroundArgv: ForegroundReader,
): Parameters<typeof launchPiSession>[1] => ({
  folder: root,
  target: { name: 'ticket-1' },
  tabName: 'architect',
  task: 'Next steps\n',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
});

export const paneRequest = (
  root: string,
  readForegroundArgv: ForegroundReader,
): Parameters<typeof launchPiSessionRightOf>[1] => ({
  folder: root,
  pane: 'p-lead',
  task: 'Design this',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
});
