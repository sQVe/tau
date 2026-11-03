import { currentTerminalAddress, get, HcError, send } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { readHandoverText } from './handoverFile.js';
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

    return {
      status: replySendStatus(reply.started),
      terminal,
      turn: reply.turn,
    };
  } catch (error) {
    return blockedOrRethrow(error, terminal);
  }
};

export const sendHandover = async (
  hc: HcRuntime,
  request: SendHandoverRequest,
): Promise<SendHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);
  const target = await get(hc, request.terminal);

  refuseCallerTerminal(target.address, request.terminal);
  hc.signal?.throwIfAborted();

  return sendText(hc, target.address, text);
};
