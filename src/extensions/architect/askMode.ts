import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isRecord } from '../../schema.js';
import { isQueuedHandover } from './queuedHandover.js';
import { readAskRecordAt, writeAskRecordAt } from './record.js';
import type { AskRecord } from './record.js';

interface HandoverInput {
  terminal: string;
  file: string;
}

export const askModePrompt = (record: AskRecord, recordPath: string): string =>
  `You answer one ask from the lead: "${record.question}". The lead terminal is ${record.leadTerminal}. The ask record is ${recordPath}. Answer the question, update the ticket if the answer changes it, then send the answer to the lead with handover send. End your turn after the send. If you need the user, send "Open the architect: <reason>" instead.`;

const handoverInput = (event: ToolResultEvent): HandoverInput | undefined => {
  if (!isRecord(event.input)) {
    return undefined;
  }

  const { terminal, file } = event.input;

  if (typeof terminal !== 'string' || typeof file !== 'string') {
    return undefined;
  }

  return { terminal, file };
};

export const registerAskMode = (pi: ExtensionAPI, recordPath: string): void => {
  pi.on('before_agent_start', async (event) => {
    const record = await readAskRecordAt(recordPath);

    if (record !== undefined) {
      appendSystemPrompt(event, askModePrompt(record, recordPath));
    }
  });

  pi.on('tool_result', async (event, context) => {
    if (!isQueuedHandover(event)) {
      return;
    }

    const record = await readAskRecordAt(recordPath);
    const input = handoverInput(event);

    if (record === undefined || input === undefined) {
      return;
    }

    if (input.terminal !== record.leadTerminal) {
      return;
    }

    const answer = await readFile(resolve(context.cwd, input.file), 'utf8');

    await writeAskRecordAt(recordPath, { ...record, status: 'sent', answer });
    context.shutdown();
  });
};
