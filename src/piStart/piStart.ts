import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import type { TSchema } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';
import { isMissingFile } from '../errors.js';
import { existingEntry } from '../tauDirectory.js';
import { piArguments } from './piArguments.js';

export type PiStartTarget = { space: string } | { name: string };

interface PiSessionRequest {
  folder: string;
  task: string;
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
  argvWrapper?: ((argv: string[]) => string[]) | undefined;
}

export interface PiStartRequest extends PiSessionRequest {
  target: PiStartTarget;
  bareRoot: boolean;
  tabName: string;
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

const launchArguments = (request: PiStartRequest, placement: LaunchPlacement): string[] => [
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

const startArguments = (request: PiStartRequest): string[] =>
  launchArguments(request, placementOf(request.target));

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

  if ((await existingEntry(join(folder, '.git'))) !== undefined) {
    return true;
  }

  return bareRoot;
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
): Promise<PiLaunchResult> => {
  try {
    const result = await runtime.exec(command.command, command.commandArguments, {
      cwd: runtime.cwd,
      timeout: launchTimeoutMilliseconds,
    });

    const { terminal, error } = terminalOf(command.label, result.stdout);

    return launchResult(runtime, result, terminal, commandError(command.label, result) ?? error);
  } catch (error) {
    return {
      exitCode: null,
      killed: false,
      timedOut: false,
      aborted: runtime.signal?.aborted === true,
      reply: undefined,
      terminal: undefined,
      error,
    };
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

export const launchPiSession = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
): Promise<PiLaunchResult> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  return launch(
    runtime,
    {
      command: 'herdr-app',
      commandArguments: startArguments(request),
      label: 'herdr-app do',
    },
    spaceTerminal,
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
  );
};

export const startPiSession = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
): Promise<{ reply: string; terminal?: string }> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  const reply = await runCommand(runtime, 'herdr-app', startArguments(request), 'herdr-app do');
  const terminal = replyTerminal(reply);

  return terminal === undefined ? { reply } : { reply, terminal };
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
