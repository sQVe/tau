import { errorMessage } from '../../errors.js';
import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import { decideEndNote } from './endNoteDecision.js';
import type { ArchitectRecordFact, EndNote, EndNoteRoute } from './endNoteDecision.js';
import { readArchitectRecord } from './record.js';

const readRecordFact = async (root: string): Promise<ArchitectRecordFact> => {
  try {
    const record = await readArchitectRecord(root);

    return record === undefined
      ? { kind: 'missing' }
      : { kind: 'read', sessionFile: record.sessionFile, updatedAt: record.updatedAt };
  } catch (error) {
    return { kind: 'unreadable', reason: errorMessage(error) };
  }
};

export const prepareEndNote = async (route: EndNoteRoute, root: string): Promise<EndNote> =>
  decideEndNote(route, await readRecordFact(root));

export const deliverEndNote = async (
  prepared: EndNote,
  hc: HcRuntime,
  report: (message: string) => void,
): Promise<void> => {
  try {
    const sent = await sendInboxMessage({
      hc,
      target: prepared.target,
      body: { family: 'handover', payload: { text: prepared.text } },
      refusal: 'Nothing was queued.',
    });

    if (sent.status === 'unknown') {
      report('The end note to the lead has an unknown delivery: the receiver may have saved it.');
    }
  } catch (error) {
    report(`The lead got no end note: ${errorMessage(error)}`);
  }
};
