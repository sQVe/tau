import type { CommandRuntime, Exec } from '../command.js';
import { errorMessage } from '../errors.js';
import type { Connect } from './connect.js';
import { HcError, isAbortError, parseCliError, parseCommandReply } from './replies.js';
import type {
  HcCommand,
  HcCommandReply,
  HcRemoveResult,
  HcTerminal,
  HcTerminalList,
  HcWaitResult,
} from './replies.js';

export interface HcRuntime extends CommandRuntime {
  connect: Connect;
}

export interface RunRequest {
  argv: string[];
  name?: string | undefined;
  cwd?: string | undefined;
  labels?: Record<string, string> | undefined;
  noParent?: boolean | undefined;
  background?: boolean | undefined;
  notify?: boolean | undefined;
  execTimeoutMilliseconds?: number | undefined;
}

export interface LsRequest {
  all?: boolean | undefined;
  labels?: Record<string, string> | undefined;
}

export interface WaitRequest {
  output?: string | undefined;
  timeout?: number | undefined;
}

export type { HcRemoveResult, HcTerminal, HcTerminalList, HcWaitResult } from './replies.js';

export { HcError } from './replies.js';

const labelFlags = (labels: Record<string, string> | undefined): string[] =>
  Object.entries(labels ?? {}).flatMap(([key, value]) => ['--label', `${key}=${value}`]);

const startFailure = (label: string, error: unknown): HcError =>
  isAbortError(error)
    ? new HcError('aborted', `${label} was aborted`)
    : new HcError('spawn_failed', `${label} failed to start: ${errorMessage(error)}`);

const runHc = async <Command extends HcCommand>(
  runtime: CommandRuntime,
  command: Command,
  commandArguments: string[],
  label: string,
  options: { timeout?: number | undefined } = {},
): Promise<HcCommandReply<Command>> => {
  let result: Awaited<ReturnType<Exec>>;

  try {
    result = await runtime.exec('hc', commandArguments, {
      cwd: runtime.cwd,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
  } catch (error) {
    throw startFailure(label, error);
  }

  if (result.code !== 0 || result.killed) {
    throw parseCliError(label, result.stderr, result.code);
  }

  return parseCommandReply(label, command, result.stdout);
};

export const run = (runtime: HcRuntime, request: RunRequest): Promise<HcTerminal> => {
  const flags: string[] = [];

  if (request.name !== undefined) {
    flags.push('--name', request.name);
  }

  if (request.cwd !== undefined) {
    flags.push('--cwd', request.cwd);
  }

  if (request.noParent === true) {
    flags.push('--no-parent');
  }

  if (request.background === true) {
    flags.push('--bg');
  }

  if (request.notify === false) {
    flags.push('--no-notify');
  }

  return runHc(
    runtime,
    'run',
    ['run', '--json', ...flags, ...labelFlags(request.labels), '--', ...request.argv],
    'hc run',
    { timeout: request.execTimeoutMilliseconds },
  );
};

export const get = (
  runtime: CommandRuntime,
  terminal: string,
  options: { timeout?: number | undefined } = {},
): Promise<HcTerminal> =>
  runHc(runtime, 'get', ['get', '--json', '--', terminal], `hc get ${terminal}`, options);

// A terminal that is not registered yet has no foreground command, so a caller that retries a read
// treats it the same as a terminal with no foreground process.
export const foregroundArgv = async (
  runtime: CommandRuntime,
  terminal: string,
): Promise<readonly string[] | undefined> => {
  let found: HcTerminal;

  try {
    found = await get(runtime, terminal);
  } catch (error) {
    if (error instanceof HcError && error.kind === 'not_found') {
      return undefined;
    }

    throw error;
  }

  return found.foreground?.argv;
};

export const ls = (runtime: HcRuntime, request: LsRequest = {}): Promise<HcTerminalList> => {
  const flags = request.all === true ? ['--all'] : [];

  return runHc(runtime, 'ls', ['ls', '--json', ...flags, ...labelFlags(request.labels)], 'hc ls');
};

export const wait = (
  runtime: HcRuntime,
  terminal: string,
  request: WaitRequest = {},
): Promise<HcWaitResult> => {
  const flags: string[] = [];

  if (request.output !== undefined) {
    flags.push('--output', request.output);
  }

  if (request.timeout !== undefined) {
    flags.push('--timeout', String(request.timeout));
  }

  return runHc(
    runtime,
    'wait',
    ['wait', '--json', ...flags, '--', terminal],
    `hc wait ${terminal}`,
  );
};

export const kill = (runtime: HcRuntime, terminal: string): Promise<HcTerminal> =>
  runHc(runtime, 'kill', ['kill', '--json', '--', terminal], `hc kill ${terminal}`);

export const rm = (runtime: HcRuntime, terminal: string): Promise<HcRemoveResult> =>
  runHc(runtime, 'rm', ['rm', '--json', '--', terminal], `hc rm ${terminal}`);

export const label = (
  runtime: HcRuntime,
  terminal: string,
  labels: Record<string, string>,
  options: { timeout?: number | undefined } = {},
): Promise<HcTerminal> => {
  const assignments = Object.entries(labels).map(([key, value]) => `${key}=${value}`);

  return runHc(
    runtime,
    'label',
    ['label', '--json', '--', terminal, ...assignments],
    `hc label ${terminal}`,
    options,
  );
};

export const currentTerminalAddress = (): string | undefined => {
  // oxlint-disable-next-line node/no-process-env -- The terminal address comes from the active process.
  const value = process.env.HC_TERMINAL_ID;

  return value === undefined || value === '' ? undefined : value;
};

export const readCurrentTerminal = (runtime: HcRuntime): Promise<HcTerminal | undefined> => {
  const address = currentTerminalAddress();

  if (address === undefined) {
    return Promise.resolve(undefined);
  }

  return get(runtime, address);
};
