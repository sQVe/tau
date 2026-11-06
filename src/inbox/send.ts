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
  // The hc address or name of the receiving terminal.
  target: string;
  body: MessageBody;
  // An explicit retry passes the ID an earlier send returned; a new message omits it.
  messageId?: string | undefined;
  // The session of the earlier unknown result; a retry is refused when the receiver changed session.
  sessionId?: string | undefined;
  // Ends every refusal message, such as the action that replaces a refused send.
  refusal: string;
}

export interface InboxSendResult {
  status: 'queued' | 'unknown';
  terminal: string;
  sessionId: string;
  messageId: string;
  // Explains an unknown result and how to retry it.
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

// One connection carries one request frame and one reply frame. `written` tells whether any request
// bytes may have reached the receiver.
const exchange = (path: string, request: string, signal: AbortSignal | undefined) =>
  new Promise<Exchange>((resolve) => {
    // Aborting destroys the socket, which reports the abort as its error.
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

// A refusal is definite: the receiver saved nothing.
const refuse = (request: InboxSendRequest, reason: string): never => {
  throw new Error(`${reason} ${request.refusal}`);
};

const resolveTarget = async (request: InboxSendRequest): Promise<Target> => {
  const terminal = await get(request.hc, request.target).catch((error: unknown) =>
    refuse(request, errorMessage(error)),
  );

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

  if (reply.messageId !== messageId) {
    return unknownResult(target, messageId, 'The receiver sent an unexpected reply.');
  }

  return { status: 'queued', terminal: reply.terminal, sessionId: reply.sessionId, messageId };
};

// Returns queued only after the receiver saved the message. Throws when the message was refused or
// never sent, and returns unknown when it may have been saved.
export const sendInboxMessage = async (request: InboxSendRequest): Promise<InboxSendResult> => {
  const messageId = request.messageId ?? randomUUID();

  if (!isUuid(messageId)) {
    return refuse(request, `The message ID is not a UUID: ${messageId}`);
  }

  const target = await resolveTarget(request);

  request.hc.signal?.throwIfAborted();

  return deliver(request, target, messageId);
};
