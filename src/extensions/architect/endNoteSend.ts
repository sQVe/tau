import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import { decideEndNote, nextFinalHandoverState } from './endNoteDecision.js';
import type { ArchitectRecordFact, FinalHandoverState } from './endNoteDecision.js';
import { finalHandoverStatus } from './queuedHandover.js';
import { readArchitectRecord } from './record.js';
import type { ArchitectSession } from './session.js';

export interface FinalHandoverTracker {
  record: (event: ToolResultEvent) => void;
  state: () => FinalHandoverState;
}

export const createFinalHandoverTracker = (): FinalHandoverTracker => {
  let state: FinalHandoverState = 'none';

  return {
    record: (event) => {
      state = nextFinalHandoverState(state, finalHandoverStatus(event));
    },
    state: () => state,
  };
};

export const readRecordFact = async (root: string): Promise<ArchitectRecordFact> => {
  try {
    const record = await readArchitectRecord(root);

    return record === undefined
      ? { kind: 'missing' }
      : { kind: 'read', sessionFile: record.sessionFile, updatedAt: record.updatedAt };
  } catch (error) {
    return { kind: 'unreadable', reason: errorMessage(error) };
  }
};

const reportFailure = (session: ArchitectSession, reason: string): void => {
  session.ui.notify(`The lead got no end note: ${reason}`, 'warning');
};

export const noteArchitectEnd = async (
  session: ArchitectSession,
  hc: HcRuntime,
  record: ArchitectRecordFact,
): Promise<void> => {
  const decision = decideEndNote({
    mode: session.owner.mode,
    leadTerminal: session.leadTerminal,
    architectTerminal: session.owner.terminal,
    finalHandover: session.finalHandover.state(),
    record,
  });

  if (decision.kind === 'none') {
    return;
  }

  try {
    const sent = await sendInboxMessage({
      hc,
      target: decision.target,
      body: { family: 'handover', payload: { text: decision.text } },
      refusal: 'Nothing was queued.',
    });

    if (sent.status !== 'queued') {
      reportFailure(session, `the send returned ${sent.status}`);
    }
  } catch (error) {
    reportFailure(session, errorMessage(error));
  }
};
