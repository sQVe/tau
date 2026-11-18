import { randomUUID } from 'node:crypto';

import { errorMessage } from '../../errors.js';
import { get } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { advertisedSession, sendInboxMessage } from '../../inbox/inbox.js';
import { changeAskRecord, isOpenLiveAsk, readAskRecord, writeAskRecord } from './record.js';
import type { LiveAskRecord } from './record.js';

export interface LiveAskRoute {
  terminal: string;
  sessionId: string;
  lockToken: string;
}

export interface LiveAskRequest {
  root: string;
  question: string;
  leadTerminal: string;
  leadSessionId: string;
  hc: HcRuntime;
}

export interface LiveAskRetry {
  root: string;
  askId: string;
  leadSessionId: string;
  hc: HcRuntime;
}

export type LiveAskResult =
  | { status: 'needsOpen'; reason: string }
  | { status: 'queued'; askId: string; terminal: string; note: string }
  | { status: 'unknown'; askId: string; terminal: string; note: string };

const noLeadInbox =
  'This lead session has no working inbox, so the answer cannot reach it. Reload Pi, then ask again.';

// A retry sends these exact bytes again, so the text depends only on the record.
const questionText = (record: LiveAskRecord): string =>
  `Ask ${record.askId} from the lead: "${record.question}". Answer it with architect answer and askId ${record.askId}. Update the ticket if the answer changes it. If you need the user, ask the user directly.`;

const leadInboxWorks = async (request: LiveAskRequest): Promise<boolean> => {
  const terminal = await get(request.hc, request.leadTerminal);

  return advertisedSession(terminal.labels ?? {}) === request.leadSessionId;
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
  root: string,
  hc: HcRuntime,
  record: LiveAskRecord,
): Promise<LiveAskResult> => {
  const sent = await sendInboxMessage({
    hc,
    target: record.architectTerminal,
    sessionId: record.architectSessionId,
    messageId: record.askId,
    body: {
      family: 'architect-ask',
      payload: { text: questionText(record), lockToken: record.architectLockToken },
    },
    refusal: 'Nothing was queued.',
  }).catch(async (error: unknown) => {
    await settleOpenAsk(root, record.askId, (current) => ({
      ...current,
      status: 'failed',
      detail: errorMessage(error),
    }));

    throw error;
  });

  const { askId } = record;

  if (sent.status === 'unknown') {
    const settled = await settleSentAsk(root, askId, 'unknown');

    if (settled.kind === 'failed') {
      return {
        status: 'unknown',
        askId,
        terminal: sent.terminal,
        note: `The question may already be in the inbox of the live architect in ${sent.terminal}, but the ask record could not be updated: ${errorMessage(settled.error)}. Retry with architect ask and askId ${askId}. Do not ask the question again as new.`,
      };
    }

    if (settled.change?.changed === false) {
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

  const settled = await settleSentAsk(root, askId, 'queued');

  if (settled.kind === 'failed') {
    return {
      status: 'queued',
      askId,
      terminal: sent.terminal,
      note: `The question reached the live architect in ${sent.terminal}, but the ask record could not be updated: ${errorMessage(settled.error)}. Do not ask the question again as new.`,
    };
  }

  if (settled.change?.changed === false) {
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

export const askLiveArchitect = async (
  request: LiveAskRequest,
  route: LiveAskRoute,
): Promise<LiveAskResult> => {
  if (!(await leadInboxWorks(request))) {
    return { status: 'needsOpen', reason: noLeadInbox };
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

  return sendQuestion(request.root, request.hc, record);
};

const retryableRecord = async (request: LiveAskRetry): Promise<LiveAskRecord> => {
  const { askId } = request;
  const record = await readAskRecord(request.root, askId);

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

  if (record.status !== 'unknown') {
    throw new Error(`Ask ${askId} is ${record.status}. Only an unknown ask can retry.`);
  }

  return record;
};

export const retryLiveAsk = async (request: LiveAskRetry): Promise<LiveAskResult> => {
  const record = await retryableRecord(request);

  return sendQuestion(request.root, request.hc, record);
};
