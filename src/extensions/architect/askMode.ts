import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isRecord } from '../../schema.js';
import { isQueuedHandover } from './queuedHandover.js';
import { readAskRecordAt, writeAskRecordAt } from './record.js';
import type { AskRecord } from './record.js';

export const askModePrompt = (record: AskRecord, recordPath: string): string =>
  `You answer one ask from the lead: "${record.question}". The lead terminal is ${record.leadTerminal}. The ask record is ${recordPath}. Answer the question, update the ticket if the answer changes it, then send the answer to the lead with handover send. End your turn after the send. If you need the user, send "Open the architect: <reason>" instead.`;

const handoverSendTarget = (event: ToolCallEvent): string | undefined => {
  if (event.toolName !== 'handover' || !isRecord(event.input)) {
    return undefined;
  }

  const { action, terminal } = event.input;

  if (action !== 'send' || typeof terminal !== 'string') {
    return undefined;
  }

  return terminal;
};

const handoverFile = (event: ToolResultEvent): string | undefined => {
  if (!isRecord(event.input)) {
    return undefined;
  }

  const { file } = event.input;

  return typeof file === 'string' ? file : undefined;
};

export const registerAskMode = (pi: ExtensionAPI, recordPath: string): void => {
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

    if (record === undefined || target === record.leadTerminal) {
      return undefined;
    }

    return {
      block: true,
      reason: `Blocked handover send to ${target}. Send the answer to the lead terminal ${record.leadTerminal}.`,
    };
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

    const answer = await readFile(resolve(context.cwd, file), 'utf8');

    await writeAskRecordAt(recordPath, { ...record, status: 'sent', answer });
    context.shutdown();
  });
};
