import type { CommandRuntime } from '../../command.js';
import type { HandoverSender } from '../../handoverSender.js';
import { senderEnvironment, senderLine } from '../../handoverSender.js';
import { startPiSession } from '../../piStart/piStart.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { tabName } from '../../tabName.js';
import { readHandoverText } from './handoverFile.js';

export interface StartHandoverRequest {
  cwd: string;
  file: string;
  folder: string;
  target: PiStartTarget;
  title: string;
  model: string | undefined;
  bareRoot: boolean;
  sender: HandoverSender | undefined;
}

export interface StartHandoverResult {
  reply: string;
}

export const startHandover = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<StartHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);
  const sender = request.sender;
  const task = sender === undefined ? text : `${senderLine(sender)}\n\n${text}`;
  const environment = sender === undefined ? undefined : senderEnvironment(sender);

  const started = await startPiSession(runtime, {
    folder: request.folder,
    target: request.target,
    tabName: tabName('lead', request.title),
    task,
    model: request.model,
    session: undefined,
    bareRoot: request.bareRoot,
    environment,
  });

  return { reply: started.reply };
};
