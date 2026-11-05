import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import type { InboxSender, SendInboxResult } from '../../inbox/inbox.js';
import { readHandoverText } from './handoverFile.js';

export interface SendHandoverRequest {
  cwd: string;
  terminal: string;
  file: string;
}

export type SendHandoverResult = SendInboxResult;

const handoverSender: InboxSender = {
  toolName: 'handover',
  recovery: 'Use handover start to open a receiver instead.',
};

export const sendHandover = async (
  hc: HcRuntime,
  request: SendHandoverRequest,
): Promise<SendHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  return sendInboxMessage({
    hc,
    target: request.terminal,
    family: 'handover',
    sender: handoverSender,
    text,
    cwd: request.cwd,
    signal: hc.signal,
  });
};
