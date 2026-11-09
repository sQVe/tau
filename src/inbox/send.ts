import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

import { errorMessage } from '../errors.js';
import { currentTerminalAddress, get } from '../hc/hc.js';
import type { HcRuntime } from '../hc/hc.js';
import { decodeReply, encodeFrame, isUuid, replyByteLimit, requestByteLimit } from './protocol.js';
import type { MessageBody, MessageReply } from './protocol.js';
import { decideTarget } from './targetDecision.js';

export interface InboxSendRequest {
  hc: HcRuntime;
  target: string;
  body: MessageBody;
  messageId?: string | undefined;
  sessionId?: string | undefined;
  refusal: string;
}

export interface InboxSendResult {
  status: 'queued' | 'unknown';
  terminal: string;
  sessionId: string;
  messageId: string;
  note?: string;
}

interface Target {
  address: string;
  path: string;
  sessionId: string;
}

type Exchange =
  | { kind: 'reply'; reply: MessageReply }
  | { kind: 'failed'; reason: string; written: boolean };

const exchangeMilliseconds = 5000;

const exchange = (path: string, request: string, signal: AbortSignal | undefined) =>
  new Promise<Exchange>((resolve) => {
    const socket = createConnection({ path, ...(signal === undefined ? {} : { signal }) });
    const chunks: Buffer[] = [];
    let size = 0;
    let written = false;

    const finish = (result: Exchange): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const fail = (reason: string): void => {
      finish({ kind: 'failed', reason, written });
    };

    const timer = setTimeout(() => {
      fail(`No reply within ${String(exchangeMilliseconds)} ms.`);
    }, exchangeMilliseconds);

    socket.once('connect', () => {
      written = true;
      socket.end(request);
    });

    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      chunks.push(chunk);

      if (size > replyByteLimit) {
        fail('The reply is too large.');
      }
    });

    socket.once('end', () => {
      const decision = decodeReply(Buffer.concat(chunks));

      if (decision.kind === 'refused') {
        fail(decision.reason);

        return;
      }

      finish({ kind: 'reply', reply: decision.value });
    });

    socket.once('error', (error) => {
      fail(errorMessage(error));
    });
  });

const refuse = (request: InboxSendRequest, reason: string): never => {
  throw new Error(`${reason} ${request.refusal}`);
};

const resolveTarget = async (request: InboxSendRequest): Promise<Target> => {
  const terminal = await get(request.hc, request.target).catch((error: unknown) => {
    request.hc.signal?.throwIfAborted();

    return refuse(request, errorMessage(error));
  });

  const decision = decideTarget({
    address: terminal.address,
    state: terminal.state,
    labels: terminal.labels ?? {},
    ownAddress: currentTerminalAddress(),
    retrySessionId: request.sessionId,
  });

  if (decision.kind === 'refuse') {
    return refuse(request, decision.reason);
  }

  return { address: terminal.address, path: decision.path, sessionId: decision.sessionId };
};

const unknownResult = (target: Target, messageId: string, reason: string): InboxSendResult => ({
  status: 'unknown',
  terminal: target.address,
  sessionId: target.sessionId,
  messageId,
  note: `${reason} Acceptance unknown for message ${messageId} to terminal ${target.address}, session ${target.sessionId}; the receiver may have saved it. A retry must reuse this message ID and the same text.`,
});

const answersFor = (
  reply: Extract<MessageReply, { kind: 'queued' }>,
  target: Target,
  messageId: string,
): boolean => {
  const sameTarget = reply.terminal === target.address && reply.sessionId === target.sessionId;

  return sameTarget && reply.messageId === messageId;
};

const deliver = async (
  request: InboxSendRequest,
  target: Target,
  messageId: string,
): Promise<InboxSendResult> => {
  const frame = encodeFrame({
    protocol: 'rpc1',
    kind: 'message',
    messageId,
    targetTerminal: target.address,
    targetSessionId: target.sessionId,
    ...request.body,
  });

  if (Buffer.byteLength(frame) > requestByteLimit) {
    return refuse(
      request,
      `The message is larger than the ${String(requestByteLimit)}-byte frame limit.`,
    );
  }

  const result = await exchange(target.path, frame, request.hc.signal);

  if (result.kind === 'failed') {
    return result.written
      ? unknownResult(target, messageId, result.reason)
      : refuse(request, `The inbox of ${target.address} did not answer: ${result.reason}`);
  }

  const { reply } = result;

  if (reply.kind === 'refused') {
    return refuse(request, reply.reason);
  }

  if (!answersFor(reply, target, messageId)) {
    return unknownResult(target, messageId, 'The receiver sent an unexpected reply.');
  }

  return { status: 'queued', terminal: target.address, sessionId: target.sessionId, messageId };
};

export const sendInboxMessage = async (request: InboxSendRequest): Promise<InboxSendResult> => {
  const messageId = request.messageId ?? randomUUID();

  if (!isUuid(messageId)) {
    return refuse(request, `The message ID is not a UUID: ${messageId}`);
  }

  const target = await resolveTarget(request);

  request.hc.signal?.throwIfAborted();

  return deliver(request, target, messageId);
};
