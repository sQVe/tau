import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Type } from 'typebox';

import { checkOutput, parseJson } from '../../command.js';
import type { CommandRuntime } from '../../command.js';
import { isMissingFile } from '../../errors.js';
import type { HandoverSender } from '../../handoverSender.js';
import { senderEnvironment, senderLine } from '../../handoverSender.js';
import { foregroundArgv } from '../../hc/hc.js';
import { listSpaces } from '../../piStart/herdrPane.js';
import { startPiSession } from '../../piStart/piStart.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { tabName } from '../../tabName.js';
import { readHandoverText } from './handoverFile.js';
import { startPlacement } from './placement.js';
import type { SpaceChoice } from './placement.js';

type SpaceStatus = 'created' | 'reused';

export interface StartHandoverRequest {
  cwd: string;
  file: string;
  folder: string;
  spaceChoice: SpaceChoice;
  title: string;
  model: string | undefined;
  bareRoot: boolean;
  sender: HandoverSender | undefined;
}

export interface StartHandoverResult {
  reply: string;
  space: string;
  tab: string;
  terminal: string;
  model: string;
  spaceStatus: SpaceStatus;
}

const launchReplySchema = Type.Object({
  space: Type.String({ minLength: 1 }),
  tab: Type.String({ minLength: 1 }),
  terminal: Type.String({ minLength: 1 }),
});

const resolvedFolder = async (
  folder: string,
  shouldRethrow: (error: unknown) => boolean,
): Promise<string> => {
  try {
    return await realpath(folder);
  } catch (error) {
    if (shouldRethrow(error)) {
      throw error;
    }

    return resolve(folder);
  }
};

const realFolder = (folder: string): Promise<string> =>
  resolvedFolder(folder, (error) => !isMissingFile(error));

// A listed space may be unreadable or on another machine, so its path must never abort the start.
const listedSpaceFolder = (folder: string): Promise<string> => resolvedFolder(folder, () => false);

const placementFor = async (runtime: CommandRuntime, request: StartHandoverRequest) => {
  const spaces = request.spaceChoice.kind === 'decide' ? await listSpaces(runtime) : [];

  const listed = await Promise.all(
    spaces.map(async (space) => ({
      id: space.id,
      name: space.name,
      folder: await listedSpaceFolder(space.folder),
      machine: space.machine,
    })),
  );

  return startPlacement({
    folder: await realFolder(request.folder),
    spaces: listed,
    spaceChoice: request.spaceChoice,
    title: request.title,
  });
};

const launchTarget = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<PiStartTarget> => {
  const placement = await placementFor(runtime, request);

  if (placement.kind === 'refuse') {
    throw new Error(placement.message);
  }

  return placement.target;
};

export const startHandover = async (
  runtime: CommandRuntime,
  request: StartHandoverRequest,
): Promise<StartHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);
  const sender = request.sender;
  const task = sender === undefined ? text : `${senderLine(sender)}\n\n${text}`;
  const environment = sender === undefined ? undefined : senderEnvironment(sender);

  const started = await startPiSession(
    runtime,
    {
      folder: request.folder,
      target: () => launchTarget(runtime, request),
      tabName: tabName('lead', request.title),
      task,
      model: request.model,
      session: undefined,
      bareRoot: request.bareRoot,
      environment,
      readForegroundArgv: (terminal, signal) => foregroundArgv({ ...runtime, signal }, terminal),
    },
    { requireTerminal: true },
  );

  const parsed = parseJson('herdr-app do', started.reply);

  checkOutput('herdr-app do', launchReplySchema, parsed);

  const spaceStatus = 'space' in started.target ? 'reused' : 'created';

  return {
    reply: started.reply,
    space: parsed.space,
    tab: parsed.tab,
    terminal: parsed.terminal,
    model: started.model,
    spaceStatus,
  };
};
