import { randomUUID } from 'node:crypto';

import { errorMessage } from '../../errors.js';
import { get } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { inboxLabelKey, ownInboxReady, sendInboxMessage } from '../../inbox/inbox.js';
import { decideArchitectInbox } from './architectInboxDecision.js';
import { readFailureDecision } from './readFailureDecision.js';
import { changeAskRecord, isOpenLiveAsk, readAskRecord, writeAskRecord } from './record.js';
import type { AskRecord, AskRecordChange, ChangeAskOptions, LiveAskRecord } from './record.js';

interface AskRefusalProof {
  leadSessionId: string;
  refusal: unknown;
}

type AskRefusalProofs = Map<string, AskRefusalProof>;

interface LiveAskRoute {
  terminal: string;
  sessionId: string;
  lockToken: string;
}

interface LiveAskRequest {
  root: string;
  question: string;
  leadTerminal: string;
  leadSessionId: string;
  listenerPath: string | undefined;
  hc: HcRuntime;
}

interface LiveAskRetry {
  root: string;
  askId: string;
  leadSessionId: string;
  hc: HcRuntime;
}

export type LiveAskResult =
  | { status: 'needsOpen'; reason: string }
  | { status: 'queued'; askId: string; terminal: string; note: string }
  | { status: 'unknown'; askId: string; terminal: string; note: string };

export type StartLiveAsk = (request: LiveAskRequest, route: LiveAskRoute) => Promise<LiveAskResult>;

type RetryLiveAsk = (request: LiveAskRetry) => Promise<LiveAskResult>;

export interface LiveAskOperations {
  ask: StartLiveAsk;
  retry: RetryLiveAsk;
}

interface RefusedAskRepair {
  root: string;
  askId: string;
  leadSessionId: string;
  refusal: unknown;
  refusals: AskRefusalProofs;
}

class AskLockHeldError extends Error {
  constructor(askId: string) {
    super(`The ask lock for ${askId} is held.`);
    this.name = 'AskLockHeldError';
  }
}

const proofKey = (root: string, askId: string): string => `${root}\n${askId}`;

const noLeadInbox =
  'This lead session has no working inbox, so the answer cannot reach it. Reload Pi, then ask again.';

const architectInboxMissing = (terminal: string): string =>
  `The live architect in ${terminal} advertises no Tau inbox. No ask was saved. Call architect ask again with the question in a few seconds. If the terminal still shows no inbox, switch to its pane to talk to the architect.`;

const missingRecordNote =
  'The question may be in the architect inbox, but its ask record is gone, so the architect cannot answer it. Call architect ask again with the question.';

// A retry sends these exact bytes again, so the text depends only on the record.
const questionText = (record: LiveAskRecord): string =>
  `Ask ${record.askId} from the lead: "${record.question}". Answer it with architect answer and askId ${record.askId}. Update the ticket if the answer changes it. If you need the user, ask the user directly.`;

const firstCopyNote = (askId: string): string =>
  `The first copy may still be in the architect inbox, so ask ${askId} stays unknown. Retry with architect ask and askId ${askId}.`;

const leadInboxWorks = async (request: LiveAskRequest): Promise<boolean> => {
  const terminal = await get(request.hc, request.leadTerminal);

  return ownInboxReady({
    listenerPath: request.listenerPath,
    labels: terminal.labels ?? {},
    sessionId: request.leadSessionId,
  });
};

type SentSettlement =
  | { kind: 'settled'; change: Awaited<ReturnType<typeof settleOpenAsk>> }
  | { kind: 'failed'; error: unknown };

const settleOpenAsk = (
  root: string,
  askId: string,
  update: (record: LiveAskRecord) => LiveAskRecord,
) =>
  changeAskRecord(root, askId, (current) => (isOpenLiveAsk(current) ? update(current) : undefined));

const failSendingAsk = (
  root: string,
  askId: string,
  leadSessionId: string,
  refusal: unknown,
  options: ChangeAskOptions = {},
): Promise<AskRecordChange | undefined> =>
  changeAskRecord(
    root,
    askId,
    (current) => {
      if (current.route !== 'live') {
        return undefined;
      }

      const ownedSending = current.status === 'sending' && current.leadSessionId === leadSessionId;

      return ownedSending
        ? { ...current, status: 'failed', detail: errorMessage(refusal) }
        : undefined;
    },
    options,
  );

const refusedSettlementSucceeded = async (
  root: string,
  askId: string,
  leadSessionId: string,
  refusal: unknown,
): Promise<boolean> => {
  try {
    await failSendingAsk(root, askId, leadSessionId, refusal);

    return true;
  } catch {
    return false;
  }
};

const recordState = (change: AskRecordChange | undefined): string =>
  change === undefined ? 'missing' : change.record.status;

const repairedRefusal = (
  refusal: unknown,
  askId: string,
  change: AskRecordChange | undefined,
): Error => {
  const state = recordState(change);
  const advice = state === 'failed' ? ' Call architect ask again with the question.' : '';

  return new Error(`${errorMessage(refusal)} Ask ${askId} is ${state}.${advice}`, {
    cause: refusal,
  });
};

const repairRecovery = (askId: string, error: unknown): string =>
  error instanceof AskLockHeldError
    ? `Retry architect ask with askId ${askId} in this session after the lock releases. Do not reload Pi.`
    : `Restore record access, then retry architect ask with askId ${askId} in this session. Do not reload Pi.`;

const repairFailed = (refusal: unknown, askId: string, error: unknown): Error =>
  new Error(
    `${errorMessage(refusal)} Ask ${askId}: the record repair could not finish: ${errorMessage(error)}. ${repairRecovery(askId, error)}`,
    { cause: refusal },
  );

const repairRefusedAsk = async (request: RefusedAskRepair): Promise<never> => {
  let change: AskRecordChange | undefined;

  try {
    change = await failSendingAsk(
      request.root,
      request.askId,
      request.leadSessionId,
      request.refusal,
      {
        onWaiting: () => {
          throw new AskLockHeldError(request.askId);
        },
      },
    );
  } catch (error) {
    request.refusals.set(proofKey(request.root, request.askId), {
      leadSessionId: request.leadSessionId,
      refusal: request.refusal,
    });

    throw repairFailed(request.refusal, request.askId, error);
  }

  request.refusals.delete(proofKey(request.root, request.askId));

  throw repairedRefusal(request.refusal, request.askId, change);
};

const settleSentAsk = async (
  root: string,
  askId: string,
  status: 'queued' | 'unknown',
): Promise<SentSettlement> => {
  try {
    const change = await settleOpenAsk(root, askId, (current) => ({ ...current, status }));

    return { kind: 'settled', change };
  } catch (error) {
    return { kind: 'failed', error };
  }
};

const sendQuestion = async (
  request: LiveAskRequest | LiveAskRetry,
  record: LiveAskRecord,
  refusals: AskRefusalProofs,
): Promise<LiveAskResult> => {
  const earlierSendUnknown = record.status === 'unknown';

  const sent = await sendInboxMessage({
    hc: request.hc,
    target: record.architectTerminal,
    sessionId: record.architectSessionId,
    messageId: record.askId,
    body: {
      family: 'architect-ask',
      payload: { text: questionText(record), lockToken: record.architectLockToken },
    },
    refusal: 'Nothing was queued.',
  }).catch(async (error: unknown) => {
    if (earlierSendUnknown) {
      throw new Error(`${errorMessage(error)} ${firstCopyNote(record.askId)}`, { cause: error });
    }

    const settled = await refusedSettlementSucceeded(
      request.root,
      record.askId,
      record.leadSessionId,
      error,
    );

    if (settled) {
      throw error;
    }

    return repairRefusedAsk({
      root: request.root,
      askId: record.askId,
      leadSessionId: record.leadSessionId,
      refusal: error,
      refusals,
    });
  });

  const { askId } = record;

  if (sent.status === 'unknown') {
    const settled = await settleSentAsk(request.root, askId, 'unknown');

    if (settled.kind === 'failed') {
      return {
        status: 'unknown',
        askId,
        terminal: sent.terminal,
        note: `The question may already be in the inbox of the live architect in ${sent.terminal}, but the ask record could not be updated: ${errorMessage(settled.error)}. Do not ask the question again as new.`,
      };
    }

    if (settled.change === undefined) {
      return { status: 'unknown', askId, terminal: sent.terminal, note: missingRecordNote };
    }

    if (!settled.change.changed) {
      return {
        status: 'unknown',
        askId,
        terminal: sent.terminal,
        note: `The saved ask is already ${settled.change.record.status}, so its record was left unchanged.`,
      };
    }

    return {
      status: 'unknown',
      askId,
      terminal: sent.terminal,
      note: `The question may already be in the inbox of the live architect in ${sent.terminal}. Retry with architect ask and askId ${askId}. Do not ask the question again as new.`,
    };
  }

  const settled = await settleSentAsk(request.root, askId, 'queued');

  if (settled.kind === 'failed') {
    return {
      status: 'queued',
      askId,
      terminal: sent.terminal,
      note: `The question reached the live architect in ${sent.terminal}, but the ask record could not be updated: ${errorMessage(settled.error)}. Do not ask the question again as new.`,
    };
  }

  if (settled.change === undefined) {
    return { status: 'queued', askId, terminal: sent.terminal, note: missingRecordNote };
  }

  if (!settled.change.changed) {
    return {
      status: 'queued',
      askId,
      terminal: sent.terminal,
      note: `The saved ask is already ${settled.change.record.status}, so its record was left unchanged.`,
    };
  }

  return {
    status: 'queued',
    askId,
    terminal: sent.terminal,
    note: `The question is in the inbox of the live architect in ${sent.terminal}. The answer arrives in your inbox and starts with "Answer to ask ${askId}". If the architect closes first, a note to ask again arrives instead.`,
  };
};

const readArchitectTerminal = async (request: LiveAskRequest, route: LiveAskRoute) => {
  try {
    return await get(request.hc, route.terminal);
  } catch (error) {
    request.hc.signal?.throwIfAborted();

    throw new Error(
      `The architect terminal ${route.terminal} could not be read: ${errorMessage(error)}. No ask was saved. Call architect ask again with the question.`,
      { cause: error },
    );
  }
};

const askLiveArchitect = async (
  request: LiveAskRequest,
  route: LiveAskRoute,
  refusals: AskRefusalProofs,
): Promise<LiveAskResult> => {
  if (!(await leadInboxWorks(request))) {
    return { status: 'needsOpen', reason: noLeadInbox };
  }

  const architectTerminal = await readArchitectTerminal(request, route);

  const inboxDecision = decideArchitectInbox({
    state: architectTerminal.state,
    inboxLabel: architectTerminal.labels?.[inboxLabelKey],
  });

  if (inboxDecision === 'inboxMissing') {
    return { status: 'needsOpen', reason: architectInboxMissing(route.terminal) };
  }

  const record: LiveAskRecord = {
    version: 2,
    route: 'live',
    askId: randomUUID(),
    createdAt: new Date().toISOString(),
    question: request.question,
    leadTerminal: request.leadTerminal,
    leadSessionId: request.leadSessionId,
    architectTerminal: route.terminal,
    architectSessionId: route.sessionId,
    architectLockToken: route.lockToken,
    status: 'sending',
    detail: null,
    answer: null,
  };

  await writeAskRecord(request.root, record);

  return sendQuestion(request, record, refusals);
};

const requireSavedLiveAsk = (
  request: LiveAskRetry,
  record: AskRecord | undefined,
): LiveAskRecord => {
  const { askId } = request;

  if (record === undefined) {
    throw new Error(`No ask record ${askId} exists. Call architect ask with the question.`);
  }

  if (record.route === 'hidden') {
    throw new Error(`Ask ${askId} is a hidden ask, so it has no live retry.`);
  }

  if (record.leadSessionId !== request.leadSessionId) {
    throw new Error(
      `Ask ${askId} belongs to lead session ${record.leadSessionId}, not this session.`,
    );
  }

  return record;
};

const recordReadFailure = (refusal: unknown, askId: string, error: unknown): Error =>
  new Error(
    `${errorMessage(refusal)} Ask ${askId}: the ask record could not be read: ${errorMessage(error)}. Restore record access, then retry architect ask with askId ${askId} in this session. Do not reload Pi.`,
    { cause: refusal },
  );

const retryLiveAsk = async (
  request: LiveAskRetry,
  refusals: AskRefusalProofs,
): Promise<LiveAskResult> => {
  const proof = refusals.get(proofKey(request.root, request.askId));

  const leadProof =
    proof !== undefined && proof.leadSessionId === request.leadSessionId ? proof : undefined;

  let saved: AskRecord | undefined;

  try {
    saved = await readAskRecord(request.root, request.askId);
  } catch (error) {
    const readDecision = readFailureDecision({
      hasRefusalProof: leadProof !== undefined,
      error,
    });

    if (readDecision === 'filesystem' && leadProof !== undefined) {
      throw recordReadFailure(leadProof.refusal, request.askId, error);
    }

    throw error;
  }

  const record = requireSavedLiveAsk(request, saved);

  if (leadProof !== undefined) {
    return repairRefusedAsk({
      root: request.root,
      askId: record.askId,
      leadSessionId: record.leadSessionId,
      refusal: leadProof.refusal,
      refusals,
    });
  }

  if (record.status !== 'unknown') {
    throw new Error(`Ask ${request.askId} is ${record.status}. Only an unknown ask can retry.`);
  }

  return sendQuestion(request, record, refusals);
};

export const createLiveAskOperations = (): LiveAskOperations => {
  const refusals: AskRefusalProofs = new Map();

  return {
    ask: (request, route) => askLiveArchitect(request, route, refusals),
    retry: (request) => retryLiveAsk(request, refusals),
  };
};
