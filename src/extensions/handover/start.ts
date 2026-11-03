import { runCommand } from '../../command.js';
import type { CommandRuntime } from '../../command.js';
import { readHandoverText } from './handoverFile.js';

export type StartHandoverTarget = { space: string } | { name: string };

export interface StartHandoverRequest {
  cwd: string;
  file: string;
  folder: string;
  target: StartHandoverTarget;
}

export interface StartHandoverResult {
  reply: string;
}

const tabArguments = (space: string, folder: string, task: string): string[] => [
  'do',
  'tab.new',
  '--space',
  space,
  '--name',
  'Manager',
  '--folder',
  folder,
  '--argv',
  '["pi"]',
  '--task',
  task,
];

const spaceArguments = (name: string, folder: string, task: string): string[] => [
  'do',
  'space.new',
  '--name',
  name,
  '--folder',
  folder,
  '--tab',
  'Manager',
  '--argv',
  '["pi"]',
  '--task',
  task,
];

const startArguments = (request: StartHandoverRequest, task: string): string[] =>
  'space' in request.target
    ? tabArguments(request.target.space, request.folder, task)
    : spaceArguments(request.target.name, request.folder, task);

export const startHandover = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<StartHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  runtime.signal?.throwIfAborted();

  const reply = await runCommand(
    runtime,
    'herdr-app',
    startArguments(request, text),
    'herdr-app do',
  );

  return { reply };
};
