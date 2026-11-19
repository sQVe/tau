import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../../errors.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { sendInboxMessage } from '../../../inbox/inbox.js';
import type { AnswerTexts } from '../answer.js';
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
  delivered: AnswerTexts;
  uncertain: AnswerTexts;
}

interface CloseFailure {
  detail: string;
  note: string;
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

const unansweredFailure = (askId: string): CloseFailure => ({
  detail: 'The architect closed before it answered.',
  note: `Ask ${askId} got no answer: the architect closed. Call architect ask again.`,
});

const uncheckedFailure = (askId: string): CloseFailure => ({
  detail: 'The architect closed and could not check whether its answer reached the lead.',
  note: `Ask ${askId}: the architect closed and could not check whether its answer reached you. If no "Answer to ask ${askId}" arrived, call architect ask again.`,
});

const tellLead = async (hc: HcRuntime, ask: LiveAskRecord, note: string): Promise<void> => {
  await sendInboxMessage({
    hc,
    target: ask.leadTerminal,
    sessionId: ask.leadSessionId,
    body: { family: 'handover', payload: { text: note } },
    refusal: 'Nothing was queued.',
  });
};

// The lead inbox replies queued for a message ID it already saved, so a resend with the same ID and
// bytes saves nothing twice.
const resendReachesLead = async (
  hc: HcRuntime,
  ask: LiveAskRecord,
  answer: string,
): Promise<boolean> => {
  try {
    const sent = await sendInboxMessage({
      hc,
      target: ask.leadTerminal,
      sessionId: ask.leadSessionId,
      messageId: ask.askId,
      body: { family: 'handover', payload: { text: answer } },
      refusal: 'Nothing was queued.',
    });

    return sent.status === 'queued';
  } catch {
    return false;
  }
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

const failAsk = async (
  ask: LiveAskRecord,
  failure: CloseFailure,
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions,
): Promise<void> => {
  const changed = await changeAskRecord(
    owner.root,
    ask.askId,
    (current) =>
      isOpenLiveAsk(current) ? { ...current, status: 'failed', detail: failure.detail } : undefined,
    options,
  );

  if (changed?.changed !== true) {
    return;
  }

  await tellLead(closing.hc, ask, failure.note).catch((error: unknown) => {
    closing.report(`The lead got no close note for ask ${ask.askId}: ${errorMessage(error)}`);
  });
};

const settleUncertain = async (
  ask: LiveAskRecord,
  answer: string,
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions,
): Promise<void> => {
  if (await resendReachesLead(closing.hc, ask, answer)) {
    await settleDelivered(ask, answer, owner, closing, options);
  } else {
    await failAsk(ask, uncheckedFailure(ask.askId), owner, closing, options);
  }
};

const settleOpenAsk = async (
  ask: LiveAskRecord,
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions,
): Promise<void> => {
  const delivered = closing.delivered.get(ask.askId);
  const uncertain = closing.uncertain.get(ask.askId);

  if (delivered !== undefined) {
    await settleDelivered(ask, delivered, owner, closing, options);
  } else if (uncertain === undefined) {
    await failAsk(ask, unansweredFailure(ask.askId), owner, closing, options);
  } else {
    await settleUncertain(ask, uncertain, owner, closing, options);
  }
};

// Each note is best effort: the caller releases the lock after this, whatever the lead receives.
// An ask whose answer reached the lead settles as answered and gets no note. An answer with an
// unknown send is sent once more.
export const failOpenLiveAsks = async (
  owner: OpenAskOwner,
  closing: AskClosing,
  options: ChangeAskOptions = {},
): Promise<void> => {
  const open = await readOpenLiveAsks(owner.root, owner.sessionId);

  await Promise.all(open.map((ask) => settleOpenAsk(ask, owner, closing, options)));
};
