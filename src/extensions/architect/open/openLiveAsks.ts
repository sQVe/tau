import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../../errors.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { sendInboxMessage } from '../../../inbox/inbox.js';
import type { DeliveredAnswers } from '../answer.js';
import { decideFinalHandover, isFinalHandoverSend } from '../finalHandoverDecision.js';
import { changeAskRecord, isOpenLiveAsk, readOpenLiveAsks } from '../record.js';
import type { ChangeAskOptions, LiveAskRecord } from '../record.js';

export interface OpenAskOwner {
  root: string;
  sessionId: string;
}

export type FinalHandoverBlock = { block: true; reason: string } | undefined;

export interface AskClosing {
  hc: HcRuntime;
  report: (message: string) => void;
  delivered: DeliveredAnswers;
}

export const blockFinalHandover = async (
  event: ToolCallEvent,
  owner: OpenAskOwner,
): Promise<FinalHandoverBlock> => {
  if (!isFinalHandoverSend(event.toolName, event.input)) {
    return undefined;
  }

  const openAsks = await readOpenLiveAsks(owner.root, owner.sessionId);

  const decision = decideFinalHandover({
    toolName: event.toolName,
    input: event.input,
    openAsks,
  });

  return decision.kind === 'block' ? { block: true, reason: decision.reason } : undefined;
};

const tellLead = async (hc: HcRuntime, ask: LiveAskRecord): Promise<void> => {
  await sendInboxMessage({
    hc,
    target: ask.leadTerminal,
    sessionId: ask.leadSessionId,
    body: {
      family: 'handover',
      payload: {
        text: `Ask ${ask.askId} got no answer: the architect closed. Call architect ask again.`,
      },
    },
    refusal: 'Nothing was queued.',
  });
};

const settleDelivered = async (
  ask: LiveAskRecord,
  answer: string,
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions,
): Promise<void> => {
  try {
    await changeAskRecord(
      owner.root,
      ask.askId,
      (current) =>
        isOpenLiveAsk(current) ? { ...current, status: 'answered', answer } : undefined,
      options,
    );
  } catch (error) {
    closing.report(
      `Ask ${ask.askId} was answered but its record could not be settled: ${errorMessage(error)}`,
    );
  }
};

const failUnanswered = async (
  ask: LiveAskRecord,
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions,
): Promise<void> => {
  const changed = await changeAskRecord(
    owner.root,
    ask.askId,
    (current) =>
      isOpenLiveAsk(current)
        ? { ...current, status: 'failed', detail: 'The architect closed before it answered.' }
        : undefined,
    options,
  );

  if (changed?.changed !== true) {
    return;
  }

  await tellLead(closing.hc, ask).catch((error: unknown) => {
    closing.report(`The lead got no close note for ask ${ask.askId}: ${errorMessage(error)}`);
  });
};

// Each note is best effort: the caller releases the lock after this, whatever the lead receives.
// An ask whose answer reached the lead settles as answered and gets no note.
export const failOpenLiveAsks = async (
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions = {},
): Promise<void> => {
  const open = await readOpenLiveAsks(owner.root, owner.sessionId);

  await Promise.all(
    open.map(async (ask) => {
      const answer = closing.delivered.get(ask.askId);

      if (answer === undefined) {
        await failUnanswered(ask, owner, closing, options);
      } else {
        await settleDelivered(ask, answer, owner, closing, options);
      }
    }),
  );
};
