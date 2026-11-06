import { Type } from 'typebox';
import type { Static, TObject, TProperties, TSchema, TUnion } from 'typebox';
import { Value } from 'typebox/value';

export type MessageRequest = Static<typeof requestSchema>;

export type MessageBody = Static<typeof bodySchema>;

export type MessageReply = QueuedReply | RefusedReply;

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

export const replyByteLimit = 4096;

const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const uuidExpression = new RegExp(uuidPattern, 'u');

export const isUuid = (value: string): boolean => uuidExpression.test(value);

export const uuidSchema = Type.String({ pattern: uuidPattern });

const strict = { additionalProperties: false } as const;

const protocolField = Type.Literal(protocolName);

const handoverBody = {
  family: Type.Literal('handover'),
  payload: Type.Object({ text: Type.String({ minLength: 1 }) }, strict),
};

const answerBody = {
  family: Type.Literal('answer'),
  payload: Type.Object(
    {
      assignmentId: uuidSchema,
      questionId: uuidSchema,
      parentSession: Type.String({ minLength: 1 }),
      answer: Type.String({ minLength: 1 }),
    },
    strict,
  ),
};

const bodySchema = Type.Union([Type.Object(handoverBody, strict), Type.Object(answerBody, strict)]);

type WithBody<Fields extends TProperties> = TUnion<
  [TObject<Fields & typeof handoverBody>, TObject<Fields & typeof answerBody>]
>;

// Builds one object schema per family from shared fields, so `family` picks the payload shape.
export const withBody = <Fields extends TProperties>(fields: Fields): WithBody<Fields> =>
  Type.Union([
    Type.Object({ ...fields, ...handoverBody }, strict),
    Type.Object({ ...fields, ...answerBody }, strict),
  ]);

const requestSchema = withBody({
  protocol: protocolField,
  kind: Type.Literal('message'),
  messageId: uuidSchema,
  targetTerminal: Type.String({ minLength: 1 }),
  targetSessionId: uuidSchema,
});

const queuedSchema = Type.Object(
  {
    protocol: protocolField,
    kind: Type.Literal('queued'),
    messageId: uuidSchema,
    terminal: Type.String({ minLength: 1 }),
    sessionId: uuidSchema,
  },
  strict,
);

const refusedSchema = Type.Object(
  {
    protocol: protocolField,
    kind: Type.Literal('refused'),
    reason: Type.String({ minLength: 1 }),
    messageId: Type.Optional(uuidSchema),
  },
  strict,
);

type QueuedReply = Static<typeof queuedSchema>;
type RefusedReply = Static<typeof refusedSchema>;

const replySchema = Type.Union([queuedSchema, refusedSchema]);

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

const decodeChecked = <Schema extends TSchema>(
  bytes: Uint8Array,
  limit: number,
  schema: Schema,
  name: string,
): FrameDecision<Static<Schema>> => {
  const frame = decodeFrame(bytes, limit);

  if (frame.kind === 'refused') {
    return frame;
  }

  const { value } = frame;

  if (!Value.Check(schema, value)) {
    return { kind: 'refused', reason: `The frame is not an ${protocolName} ${name}.` };
  }

  return { kind: 'frame', value };
};

export const decodeRequest = (bytes: Uint8Array): FrameDecision<MessageRequest> =>
  decodeChecked(bytes, requestByteLimit, requestSchema, 'request');

export const decodeReply = (bytes: Uint8Array): FrameDecision<MessageReply> =>
  decodeChecked(bytes, replyByteLimit, replySchema, 'reply');

export const encodeFrame = (value: MessageRequest | MessageReply): string =>
  `${JSON.stringify(value)}\n`;

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
