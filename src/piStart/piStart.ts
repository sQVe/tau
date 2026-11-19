import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Type } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';
import { errorMessage, isMissingFile } from '../errors.js';
import { existingEntry } from '../tauDirectory.js';
import { readHerdrLayout } from './herdrPane.js';
import { isIdleShell, soleShellPane } from './idleShellDecision.js';
import type { Foreground } from './idleShellDecision.js';
import { piArguments } from './piArguments.js';

type ReadForeground = (terminal: string) => Promise<Foreground | null | undefined>;

export type PiStartTarget = { space: string; readForeground: ReadForeground } | { name: string };

interface PiSessionRequest {
  folder: string;
  task: string;
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
}

export interface PiStartRequest extends PiSessionRequest {
  target: PiStartTarget;
  bareRoot: boolean;
}

export interface PiStartLeftOfRequest extends PiSessionRequest {
  pane: string;
  bareRoot: boolean;
}

interface SplitPaneResult {
  pane: string;
  terminal: string;
}

const splitReplySchema = Type.Object({ pane: Type.String(), terminal: Type.String() });

const argvOf = (request: PiSessionRequest, message: string | undefined): string[] =>
  piArguments({
    model: request.model,
    session: request.session,
    environment: request.environment,
    message,
  });

const tabArguments = (request: PiSessionRequest, space: string): string[] => [
  'do',
  'tab.new',
  '--space',
  space,
  '--folder',
  request.folder,
  '--argv',
  JSON.stringify(argvOf(request, undefined)),
  '--task',
  request.task,
  '--focus',
  'false',
];

const spaceArguments = (request: PiSessionRequest, name: string): string[] => [
  'do',
  'space.new',
  '--name',
  name,
  '--folder',
  request.folder,
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

const swapArguments = (pane: string, target: string): string[] => [
  'do',
  'pane.swap',
  '--pane',
  pane,
  '--target',
  target,
];

const closeArguments = (pane: string): string[] => ['do', 'pane.close', '--pane', pane];

const splitPane = async (
  runtime: CommandRuntime,
  request: PiSessionRequest,
  pane: string,
): Promise<{ split: SplitPaneResult; reply: string }> => {
  const reply = await runCommand(
    runtime,
    'herdr-app',
    splitArguments(request, pane),
    'herdr-app do pane.split',
  );

  const created = parseJson('herdr-app do pane.split', reply);

  checkOutput('herdr-app do pane.split', splitReplySchema, created);

  return { split: created, reply };
};

const startInPane = async (
  runtime: CommandRuntime,
  request: PiSessionRequest,
  pane: string,
): Promise<string> => {
  const { split, reply } = await splitPane(runtime, request, pane);

  try {
    runtime.signal?.throwIfAborted();

    await runCommand(
      runtime,
      'herdr-app',
      swapArguments(split.pane, pane),
      'herdr-app do pane.swap',
    );
  } catch (error) {
    throw new Error(
      `The session runs in pane ${split.pane} (terminal ${split.terminal}), but the swap did not finish: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return reply;
};

const takeOverShell = async (
  runtime: CommandRuntime,
  request: PiSessionRequest,
  shell: { terminal: string; pane: string },
  readForeground: ReadForeground,
): Promise<string> => {
  const { split, reply } = await splitPane(runtime, request, shell.pane);
  const foreground = await readForeground(shell.terminal);

  if (!isIdleShell(foreground, resolve(request.folder))) {
    return reply;
  }

  try {
    runtime.signal?.throwIfAborted();

    await runCommand(runtime, 'herdr-app', closeArguments(shell.pane), 'herdr-app do pane.close');
  } catch (error) {
    throw new Error(
      `The session runs in pane ${split.pane} (terminal ${split.terminal}), but the shell pane ${shell.pane} did not close: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return reply;
};

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

const startInTab = (runtime: CommandRuntime, request: PiSessionRequest, space: string) =>
  runCommand(runtime, 'herdr-app', tabArguments(request, space), 'herdr-app do');

const startInSpace = async (
  runtime: CommandRuntime,
  request: PiSessionRequest,
  target: { space: string; readForeground: ReadForeground },
): Promise<string> => {
  const layout = await readHerdrLayout(runtime);
  const space = layout.spaces.find((candidate) => candidate.id === target.space);
  const shell = soleShellPane(space);

  if (shell === undefined) {
    return startInTab(runtime, request, target.space);
  }

  const foreground = await target.readForeground(shell.terminal);

  if (!isIdleShell(foreground, resolve(request.folder))) {
    return startInTab(runtime, request, target.space);
  }

  return takeOverShell(runtime, request, shell, target.readForeground);
};

export const startPiSession = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
): Promise<{ reply: string }> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  const reply =
    'space' in request.target
      ? await startInSpace(runtime, request, request.target)
      : await runCommand(
          runtime,
          'herdr-app',
          spaceArguments(request, request.target.name),
          'herdr-app do',
        );

  return { reply };
};

export const startPiSessionLeftOf = async (
  runtime: CommandRuntime,
  request: PiStartLeftOfRequest,
): Promise<{ reply: string }> => {
  await requireCheckout(runtime, request.folder, request.bareRoot);

  return { reply: await startInPane(runtime, request, request.pane) };
};
