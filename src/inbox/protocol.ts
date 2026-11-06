import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

export type MessageRequest = HandoverMessage | AnswerMessage;

export type Request = HelloRequest | MessageRequest;

export type MessageReply = QueuedReply | RefusedReply;

export type Reply = ReadyReply | MessageReply;

export type FrameDecision<Decoded> =
  | { kind: 'frame'; value: Decoded }
  | { kind: 'refused'; reason: string };

export type InboxLabel =
  | { kind: 'socket'; path: string }
  | { kind: 'unsupported'; protocol: string };

const protocolName = 'rpc1';

export const families = ['handover', 'answer'] as const;

export type Family = (typeof families)[number];

export const inboxLabelKey = 'tau.inbox';

// Escaped JSON counts toward the limit, because the bound is on encoded bytes.
export const requestByteLimit = 102_400;

const replyByteLimit = 4096;

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const uuidExpression = new RegExp(uuidPattern, 'u');

export const isUuid = (value: string): boolean => uuidExpression.test(value);

const uuid = Type.String({ pattern: uuidPattern });

const strict = { additionalProperties: false } as const;

const protocolField = Type.Literal(protocolName);

const helloSchema = Type.Object({ protocol: protocolField, kind: Type.Literal('hello') }, strict);

const messageHeader = {
  protocol: protocolField,
  kind: Type.Literal('message'),
  messageId: uuid,
  targetTerminal: Type.String({ minLength: 1 }),
  targetSessionId: uuid,
};

const handoverSchema = Type.Object(
  {
    ...messageHeader,
    family: Type.Literal('handover'),
    payload: Type.Object({ text: Type.String({ minLength: 1 }) }, strict),
  },
  strict,
);

const answerSchema = Type.Object(
  {
    ...messageHeader,
    family: Type.Literal('answer'),
    payload: Type.Object(
      {
        assignmentId: uuid,
        questionId: uuid,
        parentSession: Type.String({ minLength: 1 }),
        answer: Type.String({ minLength: 1 }),
      },
      strict,
    ),
  },
  strict,
);

const readySchema = Type.Object(
  {
    protocol: protocolField,
    kind: Type.Literal('ready'),
    terminal: Type.String({ minLength: 1 }),
    sessionId: uuid,
    families: Type.Array(Type.Union([Type.Literal('handover'), Type.Literal('answer')])),
  },
  strict,
);

const queuedSchema = Type.Object(
  {
    protocol: protocolField,
    kind: Type.Literal('queued'),
    messageId: uuid,
    terminal: Type.String({ minLength: 1 }),
    sessionId: uuid,
  },
  strict,
);

const refusedSchema = Type.Object(
  {
    protocol: protocolField,
    kind: Type.Literal('refused'),
    reason: Type.String({ minLength: 1 }),
    messageId: Type.Optional(uuid),
  },
  strict,
);

type HelloRequest = Static<typeof helloSchema>;
type HandoverMessage = Static<typeof handoverSchema>;
type AnswerMessage = Static<typeof answerSchema>;
export type ReadyReply = Static<typeof readySchema>;
type QueuedReply = Static<typeof queuedSchema>;
export type RefusedReply = Static<typeof refusedSchema>;

const requestSchema = Type.Union([helloSchema, handoverSchema, answerSchema]);

const replySchema = Type.Union([readySchema, queuedSchema, refusedSchema]);

const newline = 0x0a;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export const refusedReply = (reason: string, messageId?: string): RefusedReply => {
  const validId = messageId !== undefined && isUuid(messageId);

  return {
    protocol: protocolName,
    kind: 'refused',
    reason,
    ...(validId ? { messageId } : {}),
  };
};

export const oversizedReason = (limit: number): string =>
  `The frame is larger than ${String(limit)} bytes.`;

const decodeText = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);

    return value;
  } catch {
    return undefined;
  }
};

// Reads one newline-terminated JSON object, the whole of a connection's input.
const decodeFrame = (bytes: Uint8Array, limit: number): FrameDecision<unknown> => {
  if (bytes.length > limit) {
    return { kind: 'refused', reason: oversizedReason(limit) };
  }

  if (bytes.at(-1) !== newline) {
    return { kind: 'refused', reason: 'The frame does not end with a newline.' };
  }

  const body = bytes.subarray(0, -1);

  if (body.includes(newline)) {
    return { kind: 'refused', reason: 'The connection carries more than one frame.' };
  }

  const text = decodeText(body);

  if (text === undefined) {
    return { kind: 'refused', reason: 'The frame is not valid UTF-8.' };
  }

  const value = parseJson(text);

  if (value === undefined) {
    return { kind: 'refused', reason: 'The frame is not valid JSON.' };
  }

  return { kind: 'frame', value };
};

export const decodeRequest = (bytes: Uint8Array): FrameDecision<Request> => {
  const frame = decodeFrame(bytes, requestByteLimit);

  if (frame.kind === 'refused') {
    return frame;
  }

  const { value } = frame;

  if (!Value.Check(requestSchema, value)) {
    return { kind: 'refused', reason: `The frame is not an ${protocolName} request.` };
  }

  return { kind: 'frame', value };
};

export const decodeReply = (bytes: Uint8Array): FrameDecision<Reply> => {
  const frame = decodeFrame(bytes, replyByteLimit);

  if (frame.kind === 'refused') {
    return frame;
  }

  const { value } = frame;

  if (!Value.Check(replySchema, value)) {
    return { kind: 'refused', reason: `The frame is not an ${protocolName} reply.` };
  }

  return { kind: 'frame', value };
};

export const encodeFrame = (value: Request | Reply): string => `${JSON.stringify(value)}\n`;

export const formatInboxLabel = (path: string): string => `${protocolName}:${path}`;

export const parseInboxLabel = (value: string): InboxLabel => {
  const separator = value.indexOf(':');
  const protocol = separator === -1 ? value : value.slice(0, separator);
  const path = value.slice(separator + 1);

  if (protocol !== protocolName || !path.startsWith('/')) {
    return { kind: 'unsupported', protocol };
  }

  return { kind: 'socket', path };
};
