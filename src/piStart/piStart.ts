import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';

import { checkOutput, parseJson, runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';
import { errorMessage, isMissingFile } from '../errors.js';
import { existingEntry, isBareRoot } from '../tauDirectory.js';
import { piArguments } from './piArguments.js';

export type PiStartTarget = { space: string } | { name: string } | { pane: string };

export interface PiStartRequest {
  folder: string;
  target: PiStartTarget;
  task: string;
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
}

const splitReplySchema = Type.Object({ pane: Type.String(), terminal: Type.String() });

const argvOf = (request: PiStartRequest, message: string | undefined): string[] =>
  piArguments({
    model: request.model,
    session: request.session,
    environment: request.environment,
    message,
  });

const tabArguments = (request: PiStartRequest, space: string): string[] => [
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

const spaceArguments = (request: PiStartRequest, name: string): string[] => [
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

const splitArguments = (request: PiStartRequest, pane: string): string[] => [
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

const startArguments = (
  request: PiStartRequest,
  target: { space: string } | { name: string },
): string[] =>
  'space' in target ? tabArguments(request, target.space) : spaceArguments(request, target.name);

const startInPane = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
  pane: string,
): Promise<string> => {
  const reply = await runCommand(
    runtime,
    'herdr-app',
    splitArguments(request, pane),
    'herdr-app do pane.split',
  );

  const created = parseJson('herdr-app do pane.split', reply);

  checkOutput('herdr-app do pane.split', splitReplySchema, created);

  try {
    runtime.signal?.throwIfAborted();

    await runCommand(
      runtime,
      'herdr-app',
      swapArguments(created.pane, pane),
      'herdr-app do pane.swap',
    );
  } catch (error) {
    throw new Error(
      `The session runs in pane ${created.pane} (terminal ${created.terminal}) to the right of pane ${pane}, because the swap did not finish: ${errorMessage(error)}`,
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

const isGitCheckout = async (folder: string): Promise<boolean> => {
  if (!(await isDirectory(folder))) {
    return false;
  }

  if ((await existingEntry(join(folder, '.git'))) !== undefined) {
    return true;
  }

  return isBareRoot(folder);
};

export const startPiSession = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
): Promise<{ reply: string }> => {
  if (!(await isGitCheckout(request.folder))) {
    throw new Error(`start folder is not a Git checkout: ${request.folder}`);
  }

  runtime.signal?.throwIfAborted();

  if ('pane' in request.target) {
    return { reply: await startInPane(runtime, request, request.target.pane) };
  }

  const reply = await runCommand(
    runtime,
    'herdr-app',
    startArguments(request, request.target),
    'herdr-app do',
  );

  return { reply };
};
