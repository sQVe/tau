import { join } from 'node:path';

import { label } from '../hc/hc.js';
import type { HcRuntime } from '../hc/hc.js';
import { serializeRecord, writeRecord } from '../record.js';
import { ensureTauDirectory, findTauRoot } from '../tauDirectory.js';
import { envelopeByteLimit } from './envelope.js';
import type { InboxEnvelope } from './envelope.js';

const inboxDirectory = 'inbox';

export const publishEnvelope = async (cwd: string, envelope: InboxEnvelope): Promise<string> => {
  const text = serializeRecord(envelope);

  if (Buffer.byteLength(text, 'utf8') > envelopeByteLimit) {
    throw new Error(
      `The envelope is larger than ${envelopeByteLimit} bytes. Nothing was queued. Use handover start instead.`,
    );
  }

  const toolName = envelope.family === 'answer' ? 'subagent_answer' : 'handover';
  const root = await findTauRoot(cwd, toolName);
  const directory = await ensureTauDirectory(root, inboxDirectory);
  const path = join(directory, `${envelope.messageId}.json`);

  await writeRecord(path, envelope);

  return path;
};

export const setMessageLabel = async (
  hc: HcRuntime,
  terminal: string,
  messageId: string,
  path: string,
): Promise<void> => {
  await label(hc, terminal, { [`tau.inbox.${messageId}`]: path });
};
