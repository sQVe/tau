import { errorMessage } from '../../errors.js';
import { readCheckedText, resolveTextFile } from '../../fileText.js';
import type { HcRuntime } from '../../hc/hc.js';
import { encodeMessageFrame, requestByteLimit, sendInboxMessage } from '../../inbox/inbox.js';
import { settleWithinCloseLimit } from './closeLimit.js';
import { changeAskRecord, isOpenLiveAsk, isOpenLiveAskStatus, readAskRecord } from './record.js';
import type { AskRecordChange, LiveAskRecord } from './record.js';

export type AnswerTexts = ReadonlyMap<string, string>;

export interface ClosedAnswers {
  // Answers the lead inbox confirmed, whose ask record could not be settled.
  delivered: AnswerTexts;
  // Answers whose send ended unknown. The lead may or may not have saved them.
  uncertain: AnswerTexts;
}

export interface AnswerRequest {
  root: string;
  cwd: string;
  askId: string;
  file: string;
  architectSessionId: string;
  hc: HcRuntime;
  hasUncertain: (askId: string) => boolean;
  recordDelivered: (askId: string, answer: string) => void;
  recordUncertain: (askId: string, answer: string) => void;
}

export type AnswerResult =
  | { status: 'queued'; askId: string; note?: string }
  | { status: 'unknown'; askId: string; note: string };

export interface AnswerTracker {
  run: <Result>(answer: () => Promise<Result>) => Promise<Result>;
  hasUncertain: (askId: string) => boolean;
  recordDelivered: (askId: string, answer: string) => void;
  recordUncertain: (askId: string, answer: string) => void;
  close: () => Promise<ClosedAnswers>;
}

type Settlement =
  | { kind: 'settled'; change: AskRecordChange | undefined }
  | { kind: 'failed'; error: unknown };

export const createAnswerTracker = (): AnswerTracker => {
  const inFlight = new Set<Promise<unknown>>();
  const delivered = new Map<string, string>();
  const uncertain = new Map<string, string>();
  let closed = false;

  return {
    run: async (answer) => {
      if (closed) {
        throw new Error('The architect is closing. Nothing was sent.');
      }

      const running = answer();

      inFlight.add(running);

      try {
        return await running;
      } finally {
        inFlight.delete(running);
      }
    },
    hasUncertain: (askId) => uncertain.has(askId),
    recordDelivered: (askId, answer) => {
      uncertain.delete(askId);
      delivered.set(askId, answer);
    },
    // The first text is the one the lead may have saved, so a later text must not replace it.
    recordUncertain: (askId, answer) => {
      if (!uncertain.has(askId)) {
        uncertain.set(askId, answer);
      }
    },
    close: async () => {
      closed = true;

      await settleWithinCloseLimit(inFlight);

      return { delivered, uncertain };
    },
  };
};

const answerableRecord = async (request: AnswerRequest): Promise<LiveAskRecord> => {
  const { askId } = request;
  const record = await readAskRecord(request.root, askId);

  if (record === undefined) {
    throw new Error(`No ask record ${askId} exists. Check the askId in the question.`);
  }

  if (record.route === 'hidden') {
    throw new Error(`Ask ${askId} went to a hidden ask session, not to this architect.`);
  }

  if (record.architectSessionId !== request.architectSessionId) {
    throw new Error(
      `Ask ${askId} went to architect session ${record.architectSessionId}, not this session.`,
    );
  }

  if (!isOpenLiveAskStatus(record.status)) {
    throw new Error(`Ask ${askId} is already ${record.status}. Nothing was sent.`);
  }

  return record;
};

const firstAnswerNote = (askId: string): string =>
  `The first answer may already be in the lead inbox, so ask ${askId} stays open. Call architect answer again with the same file, or close: closing resends the first answer once.`;

const readAnswerText = async (cwd: string, file: string): Promise<string> => {
  const realFile = await resolveTextFile(file, cwd, 'answer file');

  return readCheckedText(realFile, file, { label: 'answer file', byteLimit: requestByteLimit });
};

const assertFitsOneMessage = (record: LiveAskRecord, answer: string): void => {
  const frame = encodeMessageFrame({
    messageId: record.askId,
    targetTerminal: record.leadTerminal,
    targetSessionId: record.leadSessionId,
    body: { family: 'handover', payload: { text: answer } },
  });

  const bytes = Buffer.byteLength(frame);

  if (bytes > requestByteLimit) {
    throw new Error(
      `The answer is too large for one inbox message: ${String(bytes)} bytes, limit ${String(requestByteLimit)}. Shorten the answer file and call architect answer again.`,
    );
  }
};

const markAnswered = async (root: string, askId: string, answer: string): Promise<Settlement> => {
  try {
    const change = await changeAskRecord(root, askId, (current) =>
      isOpenLiveAsk(current) ? { ...current, status: 'answered', answer } : undefined,
    );

    return { kind: 'settled', change };
  } catch (error) {
    return { kind: 'failed', error };
  }
};

export const answerLiveAsk = async (request: AnswerRequest): Promise<AnswerResult> => {
  const record = await answerableRecord(request);
  const { askId } = record;

  const text = await readAnswerText(request.cwd, request.file);
  const answer = `Answer to ask ${askId}:\n\n${text}`;

  assertFitsOneMessage(record, answer);

  const earlierSendUnknown = request.hasUncertain(askId);

  const sent = await sendInboxMessage({
    hc: request.hc,
    target: record.leadTerminal,
    sessionId: record.leadSessionId,
    messageId: askId,
    body: { family: 'handover', payload: { text: answer } },
    refusal: 'Nothing was queued. Tell the user that the answer did not reach the lead.',
  }).catch(async (error: unknown) => {
    if (earlierSendUnknown) {
      throw new Error(`${errorMessage(error)} ${firstAnswerNote(askId)}`, { cause: error });
    }

    await changeAskRecord(request.root, askId, (current) =>
      isOpenLiveAsk(current)
        ? { ...current, status: 'failed', detail: errorMessage(error) }
        : undefined,
    );

    throw error;
  });

  if (sent.status === 'unknown') {
    request.recordUncertain(askId, answer);

    return {
      status: 'unknown',
      askId,
      note: `The answer may already be in the lead inbox. Call architect answer again with askId ${askId} and the same file.`,
    };
  }

  const settled = await markAnswered(request.root, askId, answer);

  if (settled.kind === 'failed') {
    request.recordDelivered(askId, answer);

    return {
      status: 'queued',
      askId,
      note: `The answer reached the lead inbox, but the ask record could not be updated: ${errorMessage(settled.error)}. Do not send it again.`,
    };
  }

  const { change } = settled;

  if (change?.changed === false) {
    return {
      status: 'queued',
      askId,
      note: `The answer reached the lead inbox. The ask is already ${change.record.status}, so its record was left unchanged.`,
    };
  }

  return { status: 'queued', askId };
};
