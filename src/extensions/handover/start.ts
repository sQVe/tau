import type { CommandRuntime } from '../../command.js';
import { startPiSession } from '../../piStart/piStart.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { tabName } from '../../tabName.js';
import { readHandoverText } from './handoverFile.js';

export interface StartHandoverRequest {
  cwd: string;
  file: string;
  folder: string;
  target: PiStartTarget;
  model: string | undefined;
  bareRoot: boolean;
}

export interface StartHandoverResult {
  reply: string;
}

export const startHandover = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<StartHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  return startPiSession(runtime, {
    folder: request.folder,
    target: request.target,
    tabName: tabName('lead'),
    task: text,
    model: request.model,
    session: undefined,
    bareRoot: request.bareRoot,
    environment: undefined,
  });
};
