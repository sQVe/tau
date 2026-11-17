import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { runCommand } from '../../command.js';
import type { CommandRuntime } from '../../command.js';
import { parseModelReference } from '../../config/models.js';
import { isMissingFile } from '../../errors.js';
import { existingEntry } from '../../tauDirectory.js';
import { readHandoverText } from './handoverFile.js';

export type StartHandoverTarget = { space: string } | { name: string };

export interface StartHandoverRequest {
  cwd: string;
  file: string;
  folder: string;
  target: StartHandoverTarget;
  model: string | undefined;
}

export interface StartHandoverResult {
  reply: string;
}

// Pi treats a provider prefix in --model as a hint and can fall back to another provider's model
// with the same ID. --provider pins the provider that validation accepted.
const piArguments = (model: string | undefined): string[] => {
  if (model === undefined) {
    return ['pi'];
  }

  const reference = parseModelReference(model);

  if (reference === undefined) {
    return ['pi', '--model', model];
  }

  return ['pi', '--provider', reference.provider, '--model', reference.id];
};

const tabArguments = (
  space: string,
  folder: string,
  task: string,
  model: string | undefined,
): string[] => [
  'do',
  'tab.new',
  '--space',
  space,
  '--folder',
  folder,
  '--argv',
  JSON.stringify(piArguments(model)),
  '--task',
  task,
  '--focus',
  'false',
];

const spaceArguments = (
  name: string,
  folder: string,
  task: string,
  model: string | undefined,
): string[] => [
  'do',
  'space.new',
  '--name',
  name,
  '--folder',
  folder,
  '--argv',
  JSON.stringify(piArguments(model)),
  '--task',
  task,
  '--focus',
  'false',
];

const startArguments = (request: StartHandoverRequest, task: string): string[] =>
  'space' in request.target
    ? tabArguments(request.target.space, request.folder, task, request.model)
    : spaceArguments(request.target.name, request.folder, task, request.model);

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

export const startHandover = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<StartHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  if (!(await isGitCheckout(request.folder))) {
    throw new Error(`start folder is not a Git checkout: ${request.folder}`);
  }

  runtime.signal?.throwIfAborted();

  const reply = await runCommand(
    runtime,
    'herdr-app',
    startArguments(request, text),
    'herdr-app do',
  );

  return { reply };
};
