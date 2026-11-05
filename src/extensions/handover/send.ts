import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import type { SendInboxResult } from '../../inbox/inbox.js';
import { readHandoverText } from './handoverFile.js';

export interface SendHandoverRequest {
  cwd: string;
  terminal: string;
  file: string;
}

export type SendHandoverResult = SendInboxResult;

export const sendHandover = async (
  hc: HcRuntime,
  request: SendHandoverRequest,
): Promise<SendHandoverResult> => {
  const text = await readHandoverText(request.cwd, request.file);

  return sendInboxMessage({
    hc,
    target: request.terminal,
    family: 'handover',
    text,
    cwd: request.cwd,
    signal: hc.signal,
  });
};
