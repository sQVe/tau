import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { currentTerminalAddress, get, HcError, send } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { climbsOut, ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import { errorSendStatus, replySendStatus } from './sendStatus.js';
import type { HandoverReplyStatus } from './sendStatus.js';

export interface SendHandoverRequest {
  cwd: string;
  terminal: string;
  file: string;
}

export type SendHandoverResult =
  | { status: HandoverReplyStatus; terminal: string; turn: number }
  | { status: 'blocked'; terminal: string };

const resolveHandoverFile = async (file: string, cwd: string): Promise<string> => {
  try {
    return await realpath(resolve(cwd, file));
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`handover file does not exist: ${file}`, { cause: error });
    }

    throw error;
  }
};

const readHandoverFile = async (
  directory: string,
  request: SendHandoverRequest,
): Promise<string> => {
  const realFile = await resolveHandoverFile(request.file, request.cwd);
  const realDirectory = await realpath(directory);

  if (climbsOut(relative(realDirectory, realFile))) {
    throw new Error(`handover file is outside the .tau/handovers directory: ${request.file}`);
  }

  const stats = await stat(realFile);

  if (!stats.isFile()) {
    throw new Error(`handover file is not a regular file: ${request.file}`);
  }

  if (stats.size === 0) {
    throw new Error(`handover file is empty: ${request.file}`);
  }

  return readFile(realFile, 'utf8');
};

const refuseCallerTerminal = (address: string, terminal: string): void => {
  if (address === currentTerminalAddress()) {
    throw new Error(`handover terminal is the caller's own terminal: ${terminal}`);
  }
};

const blockedOrRethrow = (error: unknown, terminal: string): SendHandoverResult => {
  const status = error instanceof HcError ? errorSendStatus(error.kind) : undefined;

  if (status === undefined) {
    throw error;
  }

  return { status, terminal };
};

const sendText = async (
  hc: HcRuntime,
  terminal: string,
  text: string,
): Promise<SendHandoverResult> => {
  try {
    const reply = await send(hc, terminal, { text });

    return { status: replySendStatus(reply.started), terminal, turn: reply.turn };
  } catch (error) {
    return blockedOrRethrow(error, terminal);
  }
};

export const sendHandover = async (
  hc: HcRuntime,
  request: SendHandoverRequest,
): Promise<SendHandoverResult> => {
  const root = await findTauRoot(request.cwd, 'handover');
  const directory = await ensureTauDirectory(root, 'handovers');
  const text = await readHandoverFile(directory, request);
  const target = await get(hc, request.terminal);

  refuseCallerTerminal(target.address, request.terminal);

  return sendText(hc, target.address, text);
};
