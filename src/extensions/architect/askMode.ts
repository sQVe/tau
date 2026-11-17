import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isRecord } from '../../schema.js';
import { readAskRecordAt, writeAskRecordAt } from './record.js';
import type { AskRecord } from './record.js';

const queuedHandover = (event: ToolResultEvent): boolean =>
  event.toolName === 'handover' && isRecord(event.details) && event.details['status'] === 'queued';

export const askModePrompt = (record: AskRecord, recordPath: string): string =>
  `You answer one ask from the lead: "${record.question}". The lead terminal is ${record.leadTerminal}. The ask record is ${recordPath}. Answer the question, update the ticket if the answer changes it, then send the answer to the lead with handover send. End your turn after the send. If you need the user, send "Open the architect: <reason>" instead.`;

export const registerAskMode = (pi: ExtensionAPI, recordPath: string): void => {
  pi.on('before_agent_start', async (event) => {
    const record = await readAskRecordAt(recordPath);

    if (record !== undefined) {
      appendSystemPrompt(event, askModePrompt(record, recordPath));
    }
  });

  pi.on('tool_result', async (event, context) => {
    if (!queuedHandover(event)) {
      return;
    }

    const record = await readAskRecordAt(recordPath);

    if (record === undefined) {
      return;
    }

    await writeAskRecordAt(recordPath, { ...record, status: 'sent' });
    context.shutdown();
  });
};
