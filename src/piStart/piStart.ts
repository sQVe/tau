import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { Type } from 'typebox';
import type { TSchema } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';
import { parseModelReference } from '../config/models.js';
import { isMissingFile, toError } from '../errors.js';
import { isGitRepository } from '../git.js';
import { piArguments } from './piArguments.js';
import { decideStartedModel } from './startedModel.js';
import type { RequestedModel, StartedModelDecision } from './startedModel.js';

export type PiStartTarget = { space: string } | { name: string };

type PiStartTargetResolver = () => Promise<PiStartTarget>;

interface PiSessionRequest {
  folder: string;
  task: string;
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
  readForegroundArgv: (terminal: string) => Promise<readonly string[] | undefined>;
  argvWrapper?: ((argv: string[]) => string[]) | undefined;
}

interface PiStartBaseRequest extends PiSessionRequest {
  bareRoot: boolean;
  tabName: string;
}

interface PiLaunchRequest extends PiStartBaseRequest {
  target: PiStartTarget;
}

export interface PiStartRequest extends PiStartBaseRequest {
  target: PiStartTarget | PiStartTargetResolver;
}

export interface PiStartRightOfRequest extends PiSessionRequest {
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
  // Undefined means no readback happened, so the started model is unknown.
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

const readbackIntervalMilliseconds = 100;

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

const requestedModelOf = (model: string | undefined): RequestedModel => {
  if (model === undefined) {
    return { provider: undefined, id: undefined };
  }

  return parseModelReference(model) ?? { provider: undefined, id: model };
};

const unreadableModelError = (terminal: string, cause?: unknown): Error => {
  const options = cause === undefined ? undefined : { cause };

  return new Error(
    `The started model on terminal ${terminal} is unknown. It may still be running; check it with hc get ${terminal} before you start another.`,
    options,
  );
};

const mismatchModelError = (
  terminal: string,
  decision: Extract<StartedModelDecision, { kind: 'mismatch' }>,
): Error =>
  new Error(
    `The started Pi on terminal ${terminal} runs ${decision.started}, but the request asked for ${decision.requested}. It may still be running; check it with hc get ${terminal} before you start another.`,
  );

const cancellationError = (signal: AbortSignal | undefined): Error => {
  const reason: unknown = signal?.reason;

  return reason instanceof Error
    ? reason
    : new Error('The started model readback was cancelled.', { cause: reason });
};

const piArgv = (argv: readonly string[] | undefined): readonly string[] | undefined =>
  argv?.[0] === 'pi' ? argv : undefined;

// Each read shares one deadline with the whole readback, so a slow terminal cannot extend the
// launch budget.
const readWithinBudget = (
  read: () => Promise<readonly string[] | undefined>,
  remaining: number,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | undefined> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, remaining);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancellationError(signal));
    };

    if (signal?.aborted === true) {
      onAbort();

      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    void read().then(
      (argv) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(argv);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(toError(error));
      },
    );
  });

const readStartedModel = async (
  readForegroundArgv: (terminal: string) => Promise<readonly string[] | undefined>,
  terminal: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const requested = requestedModelOf(model);
  const deadline = Date.now() + launchTimeoutMilliseconds;

  for (;;) {
    let argv: readonly string[] | undefined;

    try {
      // oxlint-disable-next-line no-await-in-loop -- each read must wait for the previous one.
      argv = await readWithinBudget(
        () => readForegroundArgv(terminal),
        deadline - Date.now(),
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true) {
        throw cancellationError(signal);
      }

      throw unreadableModelError(terminal, error);
    }

    const startedArgv = piArgv(argv);

    if (startedArgv !== undefined) {
      const decision = decideStartedModel({ requested, argv: startedArgv });

      if (decision.kind === 'match') {
        return decision.model;
      }

      if (decision.kind === 'mismatch') {
        throw mismatchModelError(terminal, decision);
      }

      throw unreadableModelError(terminal);
    }

    if (Date.now() >= deadline) {
      throw unreadableModelError(terminal);
    }

    // oxlint-disable-next-line no-await-in-loop -- the poll needs a pause between reads.
    await sleep(readbackIntervalMilliseconds);
  }
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

const requireCheckout = async (
  runtime: CommandRuntime,
  folder: string,
  bareRoot: boolean,
): Promise<void> => {
  if (!(await isGitCheckout(folder, bareRoot))) {
    throw new Error(`start folder is not a Git checkout: ${folder}`);
  }

  runtime.signal?.throwIfAborted();
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

const launch = async (
  runtime: CommandRuntime,
  command: LaunchCommand,
  terminalOf: TerminalReply,
  request: PiSessionRequest,
): Promise<PiLaunchResult> => {
  let launched: PiLaunchResult;

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

  const model = await readStartedModel(
    request.readForegroundArgv,
    launched.terminal,
    request.model,
    runtime.signal,
  );

  return { ...launched, model };
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
): Promise<{ reply: string; target: PiStartTarget; terminal?: string; model?: string }> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  const target = isTargetResolver(request.target) ? await request.target() : request.target;

  // The resolver awaits, so the signal can abort after the checkout check above.
  runtime.signal?.throwIfAborted();

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

  const model = await readStartedModel(
    request.readForegroundArgv,
    terminal,
    request.model,
    runtime.signal,
  );

  return { reply, target, terminal, model };
};

export const startPiSessionRightOf = async (
  runtime: CommandRuntime,
  request: PiStartRightOfRequest,
): Promise<{ reply: string; terminal?: string }> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  const reply = await runCommand(
    runtime,
    'herdr-app',
    splitArguments(request, request.pane),
    'herdr-app do pane.split',
  );

  const created = parseJson('herdr-app do pane.split', reply);

  checkOutput('herdr-app do pane.split', splitReplySchema, created);

  return { reply, terminal: created.terminal };
};
