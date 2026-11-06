import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import type { InboxSendResult } from '../../inbox/inbox.js';
import { readHandoverText } from './handoverFile.js';

export interface SendHandoverRequest {
  cwd: string;
  terminal: string;
  file: string;
  // Set only to retry a send whose result was unknown.
  messageId?: string | undefined;
  sessionId?: string | undefined;
}

export type SendHandoverResult = InboxSendResult;

export const sendHandover = async (
  hc: HcRuntime,
  request: SendHandoverRequest,
): Promise<SendHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  return sendInboxMessage({
    hc,
    target: request.terminal,
    body: { family: 'handover', payload: { text } },
    messageId: request.messageId,
    sessionId: request.sessionId,
    refusal: 'Nothing was queued. Use handover start to open a receiver instead.',
  });
};
