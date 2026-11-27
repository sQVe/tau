import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from '../../../instructions/systemPrompt.js';
import { isRecord } from '../../../schema.js';
import { handoverSendTarget, handoverTargetRefusal } from '../handoverTargetDecision.js';
import { isQueuedHandover } from '../queuedHandover.js';
import { readAskRecordAt, updateHiddenAskRecordAt } from '../record.js';
import type { AskRecord } from '../record.js';
import { askEndedDetail } from './askHiddenRun.js';

export const askModePrompt = (record: AskRecord, recordPath: string): string =>
  `You answer one ask from the lead: "${record.question}". The lead terminal is ${record.leadTerminal}. The ask record is ${recordPath}. Answer only this ask, and ignore other ask messages in the inbox. Answer the question, update the ticket if the answer changes it, then send the answer to the lead with handover send. End your turn after the send. If you need the user, send "Open the architect: <reason>" instead.`;

const handoverFile = (event: ToolResultEvent): string | undefined => {
  if (!isRecord(event.input)) {
    return undefined;
  }

  const { file } = event.input;

  return typeof file === 'string' ? file : undefined;
};

export const registerAskMode = (
  pi: ExtensionAPI,
  checkoutOf: () => string | undefined,
  recordPath: string,
): void => {
  pi.on('before_agent_start', async (event) => {
    const record = await readAskRecordAt(recordPath);

    if (record !== undefined) {
      appendSystemPrompt(event, askModePrompt(record, recordPath));
    }
  });

  pi.on('tool_call', async (event) => {
    const target = handoverSendTarget(event);

    if (target === undefined) {
      return undefined;
    }

    const record = await readAskRecordAt(recordPath);
    const refusal = handoverTargetRefusal(target, record?.leadTerminal);

    return refusal === undefined ? undefined : { block: true, reason: refusal };
  });

  pi.on('agent_settled', async (_event, context) => {
    const checkout = checkoutOf();

    if (checkout === undefined) {
      return;
    }

    const record = await readAskRecordAt(recordPath);

    if (record?.route !== 'hidden' || record.status !== 'running') {
      return;
    }

    const change = await updateHiddenAskRecordAt(checkout, recordPath, (current) => ({
      ...current,
      status: 'failed',
      detail: askEndedDetail,
    }));

    if (change?.changed === true) {
      context.shutdown();
    }
  });

  pi.on('tool_result', async (event, context) => {
    if (!isQueuedHandover(event)) {
      return;
    }

    const record = await readAskRecordAt(recordPath);
    const file = handoverFile(event);

    if (record?.route !== 'hidden' || file === undefined) {
      return;
    }

    const checkout = checkoutOf();

    if (checkout === undefined) {
      return;
    }

    const answer = await readFile(resolve(context.cwd, file), 'utf8');

    const change = await updateHiddenAskRecordAt(checkout, recordPath, (current) => ({
      ...current,
      status: 'sent',
      answer,
    }));

    if (change?.changed === true) {
      context.shutdown();
    }
  });
};
