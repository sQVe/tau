import { stat } from 'node:fs/promises';

import { Type } from 'typebox';
import type { TSchema } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';
import { errorMessage, isMissingFile } from '../errors.js';
import { isGitRepository } from '../git.js';
import { isRecord } from '../schema.js';
import { piArguments } from './piArguments.js';
import { readStartedModel } from './startedModel/startedModelReadback.js';
import type { ReadForegroundArgv } from './startedModel/startedModelReadback.js';

export type PiStartTarget = { space: string } | { name: string };

type PiStartTargetResolver = () => Promise<PiStartTarget>;

interface PiSessionRequest {
  folder: string;
  task: string;
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
  argvWrapper?: ((argv: string[]) => string[]) | undefined;
}

interface PiReadbackRequest extends PiSessionRequest {
  readForegroundArgv: ReadForegroundArgv;
}

interface PiStartBaseRequest extends PiReadbackRequest {
  bareRoot: boolean;
  tabName: string;
}

interface PiLaunchRequest extends PiStartBaseRequest {
  target: PiStartTarget;
}

export interface PiStartRequest extends PiStartBaseRequest {
  target: PiStartTarget | PiStartTargetResolver;
}

export interface PiStartRightOfRequest extends PiReadbackRequest {
  pane: string;
  bareRoot: boolean;
}

interface LaunchPlacement {
  command: string;
  destinationFlag: string;
  destination: string;
  tabNameFlag: string;
}

export interface PiLaunchResult {
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  aborted: boolean;
  reply: string | undefined;
  terminal: string | undefined;
  // Undefined means no readback happened, or it failed and `error` carries the failure. A launch
  // can set `error` while `terminal` is live, so a caller must read both fields.
  model: string | undefined;
  error: unknown;
}

interface LaunchCommand {
  command: string;
  commandArguments: string[];
  label: string;
}

type TerminalReply = (
  label: string,
  reply: string,
) => {
  terminal: string | undefined;
  error: unknown;
};

export const launchTimeoutMilliseconds = 30_000;
// A launch that used its whole budget still leaves a window to read the model, so a slow launch is
// not reported as an unknown model.
const readbackMinimumMilliseconds = 5_000;

const readbackDeadline = (deadline: number): number =>
  Math.max(deadline, Date.now() + readbackMinimumMilliseconds);

const splitReplySchema = Type.Object({
  pane: Type.String(),
  terminal: Type.String({ minLength: 1 }),
});

const terminalReplySchema = Type.Object({
  terminal: Type.String({ minLength: 1 }),
});

const argvOf = (request: PiSessionRequest, message: string | undefined): string[] => {
  const argv = piArguments({
    model: request.model,
    session: request.session,
    environment: request.environment,
    message,
  });

  return request.argvWrapper === undefined ? argv : request.argvWrapper(argv);
};

const placementOf = (target: PiStartTarget): LaunchPlacement =>
  'space' in target
    ? {
        command: 'tab.new',
        destinationFlag: '--space',
        destination: target.space,
        tabNameFlag: '--name',
      }
    : {
        command: 'space.new',
        destinationFlag: '--name',
        destination: target.name,
        tabNameFlag: '--tab',
      };

const launchArguments = (request: PiStartBaseRequest, placement: LaunchPlacement): string[] => [
  'do',
  placement.command,
  placement.destinationFlag,
  placement.destination,
  '--folder',
  request.folder,
  placement.tabNameFlag,
  request.tabName,
  '--argv',
  JSON.stringify(argvOf(request, undefined)),
  '--task',
  request.task,
  '--focus',
  'false',
];

const splitArguments = (request: PiSessionRequest, pane: string): string[] => [
  'do',
  'pane.split',
  '--direction',
  'right',
  '--pane',
  pane,
  '--argv',
  JSON.stringify(['env', '-C', request.folder, ...argvOf(request, request.task)]),
];

const startArguments = (request: PiStartBaseRequest, target: PiStartTarget): string[] =>
  launchArguments(request, placementOf(target));

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (stats) => stats.isDirectory(),
    (error: unknown) => {
      if (isMissingFile(error)) {
        return false;
      }

      throw error;
    },
  );

const isGitCheckout = async (folder: string, bareRoot: boolean): Promise<boolean> => {
  if (!(await isDirectory(folder))) {
    return false;
  }

  return bareRoot || (await isGitRepository(folder));
};

// The abort signal's reason may be a plain value, which would reject with a non-Error.
const normalizeLaunchCancellation = (signal: AbortSignal | undefined, error: unknown): unknown =>
  signal?.aborted === true && !(error instanceof Error)
    ? new Error('The Pi launch was cancelled.', { cause: error })
    : error;

const throwIfLaunchCancelled = (signal: AbortSignal | undefined): void => {
  try {
    signal?.throwIfAborted();
  } catch (error) {
    throw normalizeLaunchCancellation(signal, error);
  }
};

const requireCheckout = async (
  runtime: CommandRuntime,
  folder: string,
  bareRoot: boolean,
): Promise<void> => {
  if (!(await isGitCheckout(folder, bareRoot))) {
    throw new Error(`start folder is not a Git checkout: ${folder}`);
  }

  throwIfLaunchCancelled(runtime.signal);
};

const launchResult = (
  runtime: CommandRuntime,
  result: Awaited<ReturnType<CommandRuntime['exec']>>,
  terminal: string | undefined,
  error: unknown,
): PiLaunchResult => ({
  exitCode: result.code,
  killed: result.killed,
  timedOut: result.killed,
  aborted: runtime.signal?.aborted === true,
  reply: result.stdout,
  terminal,
  model: undefined,
  error,
});

const commandError = (
  label: string,
  result: Awaited<ReturnType<CommandRuntime['exec']>>,
): unknown => {
  if (result.code === 0 && !result.killed) {
    return undefined;
  }

  const output = (result.stderr || result.stdout).trim();

  return new Error(`${label} failed: ${output}`);
};

const findTerminal = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || !('terminal' in value)) {
    return undefined;
  }

  const terminal = value.terminal;

  return typeof terminal === 'string' && terminal !== '' ? terminal : undefined;
};

const replyTerminal = (reply: string): string | undefined => {
  try {
    return findTerminal(JSON.parse(reply));
  } catch {
    return undefined;
  }
};

const replyField = (reply: string, field: 'space' | 'tab'): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(reply);

    if (!isRecord(parsed)) {
      return undefined;
    }

    const value = parsed[field];

    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
};

// The readback runs after the tab exists, so a failure must still name the tab a caller can stop.
const startedTabError = (reply: string, terminal: string, error: unknown): Error => {
  const space = replyField(reply, 'space');
  const tab = replyField(reply, 'tab');
  const places: string[] = [];

  if (space !== undefined) {
    places.push(`space ${space}`);
  }

  if (tab !== undefined) {
    places.push(`tab ${tab}`);
  }

  const where = places.length === 0 ? '' : ` (${places.join(', ')})`;
  const reason = errorMessage(error).replace(/[.!?]$/u, '');
  const reasonPrefix = reason === '' ? '' : `${reason}. `;

  return new Error(
    `${reasonPrefix}The started terminal ${terminal}${where} is still running; stop it with hc kill ${terminal} if you do not want to keep it.`,
    { cause: error },
  );
};

const readStartedTerminalModel = async (
  request: PiReadbackRequest,
  reply: string,
  terminal: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  try {
    return await readStartedModel({
      readForegroundArgv: request.readForegroundArgv,
      terminal,
      model: request.model,
      signal,
      deadline: readbackDeadline(deadline),
    });
  } catch (error) {
    throw startedTabError(reply, terminal, error);
  }
};

const launch = async (
  runtime: CommandRuntime,
  command: LaunchCommand,
  terminalOf: TerminalReply,
  request: PiReadbackRequest,
): Promise<PiLaunchResult> => {
  let launched: PiLaunchResult;
  const deadline = Date.now() + launchTimeoutMilliseconds;

  try {
    const result = await runtime.exec(command.command, command.commandArguments, {
      cwd: runtime.cwd,
      timeout: launchTimeoutMilliseconds,
    });

    const { terminal, error } = terminalOf(command.label, result.stdout);

    launched = launchResult(
      runtime,
      result,
      terminal,
      commandError(command.label, result) ?? error,
    );
  } catch (error) {
    return {
      exitCode: null,
      killed: false,
      timedOut: false,
      aborted: runtime.signal?.aborted === true,
      reply: undefined,
      terminal: undefined,
      model: undefined,
      error,
    };
  }

  if (launched.terminal === undefined || launched.error !== undefined) {
    return launched;
  }

  try {
    const model = await readStartedTerminalModel(
      request,
      launched.reply ?? '',
      launched.terminal,
      deadline,
      runtime.signal,
    );

    return { ...launched, model };
  } catch (error) {
    return { ...launched, error };
  }
};

const terminalFromReply = (
  schema: TSchema,
  label: string,
  reply: string,
): { terminal: string | undefined; error: unknown } => {
  try {
    const created = parseJson(label, reply);

    checkOutput(label, schema, created);

    return { terminal: findTerminal(created), error: undefined };
  } catch (error) {
    return { terminal: undefined, error };
  }
};

const spaceTerminal: TerminalReply = (label, reply) =>
  terminalFromReply(terminalReplySchema, label, reply);

const splitTerminal: TerminalReply = (label, reply) =>
  terminalFromReply(splitReplySchema, label, reply);

const isTargetResolver = (
  target: PiStartTarget | PiStartTargetResolver,
): target is PiStartTargetResolver => typeof target === 'function';

export const launchPiSession = async (
  runtime: CommandRuntime,
  request: PiLaunchRequest,
): Promise<PiLaunchResult> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  return launch(
    runtime,
    {
      command: 'herdr-app',
      commandArguments: startArguments(request, request.target),
      label: 'herdr-app do',
    },
    spaceTerminal,
    request,
  );
};

export const launchPiSessionRightOf = async (
  runtime: CommandRuntime,
  request: PiStartRightOfRequest,
): Promise<PiLaunchResult> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  return launch(
    runtime,
    {
      command: 'herdr-app',
      commandArguments: splitArguments(request, request.pane),
      label: 'herdr-app do pane.split',
    },
    splitTerminal,
    request,
  );
};

export const startPiSession = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
): Promise<
  | { reply: string; target: PiStartTarget }
  | { reply: string; target: PiStartTarget; terminal: string; model: string }
> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  const target = isTargetResolver(request.target) ? await request.target() : request.target;

  // The resolver awaits, so the signal can abort after the checkout check above.
  throwIfLaunchCancelled(runtime.signal);

  const deadline = Date.now() + launchTimeoutMilliseconds;

  const reply = await runCommand(
    runtime,
    'herdr-app',
    startArguments(request, target),
    'herdr-app do',
  );

  const terminal = replyTerminal(reply);

  if (terminal === undefined) {
    return { reply, target };
  }

  const model = await readStartedTerminalModel(request, reply, terminal, deadline, runtime.signal);

  return { reply, target, terminal, model };
};

export const startPiSessionRightOf = async (
  runtime: CommandRuntime,
  request: PiStartRightOfRequest,
): Promise<{ reply: string; terminal: string; model: string | undefined }> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  const deadline = Date.now() + launchTimeoutMilliseconds;

  const reply = await runCommand(
    runtime,
    'herdr-app',
    splitArguments(request, request.pane),
    'herdr-app do pane.split',
  );

  const created = parseJson('herdr-app do pane.split', reply);

  checkOutput('herdr-app do pane.split', splitReplySchema, created);

  const terminal = created.terminal;

  // The split already created the terminal, so an abort that arrived while the command ran still
  // reports it. The readback is skipped because the abort would cancel it.
  if (runtime.signal?.aborted === true) {
    return { reply, terminal, model: undefined };
  }

  const model = await readStartedTerminalModel(request, reply, terminal, deadline, runtime.signal);

  return { reply, terminal, model };
};
