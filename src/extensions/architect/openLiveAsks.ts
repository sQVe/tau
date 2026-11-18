import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import type { HcRuntime } from '../../hc/hc.js';
import { sendInboxMessage } from '../../inbox/inbox.js';
import { decideFinalHandover, isFinalHandoverSend } from './finalHandoverDecision.js';
import { changeAskRecord, isOpenLiveAsk, readOpenLiveAsks } from './record.js';
import type { ChangeAskOptions, LiveAskRecord } from './record.js';

export interface OpenAskOwner {
  root: string;
  sessionId: string;
}

export type FinalHandoverBlock = { block: true; reason: string } | undefined;

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

// Each note is best effort: the caller releases the lock after this, whatever the lead receives.
export const failOpenLiveAsks = async (
  owner: OpenAskOwner,
  hc: HcRuntime,
  report: (message: string) => void,
  options: ChangeAskOptions = {},
): Promise<void> => {
  const open = await readOpenLiveAsks(owner.root, owner.sessionId);

  await Promise.all(
    open.map(async (ask) => {
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

      await tellLead(hc, ask).catch((error: unknown) => {
        report(`The lead got no close note for ask ${ask.askId}: ${errorMessage(error)}`);
      });
    }),
  );
};
