import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { runCommand } from '../command.js';
import type { CommandRuntime } from '../command.js';
import { isMissingFile } from '../errors.js';
import { existingEntry } from '../tauDirectory.js';
import { piArguments } from './piArguments.js';

export type PiStartTarget = { space: string } | { name: string };

export interface PiStartRequest {
  folder: string;
  target: PiStartTarget;
  task: string;
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
}

const argvOf = (request: PiStartRequest): string[] =>
  piArguments({
    model: request.model,
    session: request.session,
    environment: request.environment,
    message: undefined,
  });

const tabArguments = (request: PiStartRequest, space: string): string[] => [
  'do',
  'tab.new',
  '--space',
  space,
  '--folder',
  request.folder,
  '--argv',
  JSON.stringify(argvOf(request)),
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
  JSON.stringify(argvOf(request)),
  '--task',
  request.task,
  '--focus',
  'false',
];

const startArguments = (request: PiStartRequest): string[] =>
  'space' in request.target
    ? tabArguments(request, request.target.space)
    : spaceArguments(request, request.target.name);

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

  return (await existingEntry(join(folder, '.git'))) !== undefined;
};

export const startPiSession = async (
  runtime: CommandRuntime,
  request: PiStartRequest,
): Promise<{ reply: string }> => {
  if (!(await isGitCheckout(request.folder))) {
    throw new Error(`start folder is not a Git checkout: ${request.folder}`);
  }

  runtime.signal?.throwIfAborted();

  const reply = await runCommand(runtime, 'herdr-app', startArguments(request), 'herdr-app do');

  return { reply };
};
