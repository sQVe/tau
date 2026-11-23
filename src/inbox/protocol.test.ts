import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  decodeReply,
  decodeRequest,
  encodeFrame,
  formatInboxLabel,
  parseInboxLabel,
  refusedReply,
} from './protocol.js';

const messageId = '0190c1d2-0000-7000-8000-000000000001';
const sessionId = '0190c1d2-0000-7000-8000-000000000002';
const assignmentId = '0190c1d2-0000-7000-8000-000000000003';
const questionId = '0190c1d2-0000-7000-8000-000000000004';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const line = (value: unknown): Uint8Array => bytes(`${JSON.stringify(value)}\n`);

const handover = {
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 't1',
  targetSessionId: sessionId,
  family: 'handover',
  payload: { text: 'handover text' },
} as const;

const sender = { terminal: 'lead', sessionId };

const handoverWithSender = {
  ...handover,
  payload: { ...handover.payload, sender },
} as const;

const answer = {
  ...handover,
  family: 'answer',
  payload: { assignmentId, questionId, parentSession: 'manager-session', answer: 'Use option A.' },
} as const;

const answerRequest = {
  ...handover,
  family: 'answer-request',
  payload: { assignmentId, questionId, answer: 'Use 42.' },
} as const;

const architectAsk = {
  ...handover,
  family: 'architect-ask',
  payload: { text: 'Ask text', lockToken: 'lock-1' },
} as const;

const requestCases: [string, Uint8Array, ReturnType<typeof decodeRequest>][] = [
  ['a handover message', line(handover), { kind: 'frame', value: handover }],
  [
    'a handover message with a sender',
    line(handoverWithSender),
    { kind: 'frame', value: handoverWithSender },
  ],
  [
    'a handover message with an extra field inside sender',
    line({ ...handover, payload: { ...handover.payload, sender: { ...sender, extra: true } } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a handover message with an empty sender terminal',
    line({ ...handover, payload: { ...handover.payload, sender: { ...sender, terminal: '' } } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a handover message with whitespace in the sender terminal',
    line({
      ...handover,
      payload: { ...handover.payload, sender: { ...sender, terminal: 'lead terminal' } },
    }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a handover message with a sender session ID that Pi does not accept',
    line({
      ...handover,
      payload: { ...handover.payload, sender: { ...sender, sessionId: '../escape' } },
    }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  ['an architect-ask message', line(architectAsk), { kind: 'frame', value: architectAsk }],
  [
    'an architect-ask without a lock token',
    line({ ...architectAsk, payload: { text: 'Ask text' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an architect-ask with an empty lock token',
    line({ ...architectAsk, payload: { text: 'Ask text', lockToken: '' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  ['an answer message', line(answer), { kind: 'frame', value: answer }],
  [
    'an answer-request with an assignment ID that is not a UUID',
    line({ ...answerRequest, payload: { ...answerRequest.payload, assignmentId: 'job-1' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an answer-request with a question ID that is not a UUID',
    line({ ...answerRequest, payload: { ...answerRequest.payload, questionId: 'job-1' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an answer-request with an empty answer',
    line({ ...answerRequest, payload: { ...answerRequest.payload, answer: '' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an answer-request with 32000 answer characters',
    line({ ...answerRequest, payload: { ...answerRequest.payload, answer: 'a'.repeat(32_000) } }),
    {
      kind: 'frame',
      value: {
        ...answerRequest,
        payload: { ...answerRequest.payload, answer: 'a'.repeat(32_000) },
      },
    },
  ],
  [
    'an answer-request with 32001 answer characters',
    line({ ...answerRequest, payload: { ...answerRequest.payload, answer: 'a'.repeat(32_001) } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a handover message to a custom Pi session ID',
    line({ ...handover, targetSessionId: 'job-1' }),
    { kind: 'frame', value: { ...handover, targetSessionId: 'job-1' } },
  ],
  [
    'a target session ID that Pi does not accept',
    line({ ...handover, targetSessionId: '../escape' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a message ID that is a custom session ID but not a UUID',
    line({ ...handover, messageId: 'job-1' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an assignment ID that is not a UUID',
    line({ ...answer, payload: { ...answer.payload, assignmentId: 'job-1' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a question ID that is not a UUID',
    line({ ...answer, payload: { ...answer.payload, questionId: 'job-1' } }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a frame over 102400 bytes',
    line({ ...handover, payload: { text: 'a'.repeat(102_400) } }),
    { kind: 'refused', reason: 'The frame is larger than 102400 bytes.' },
  ],
  [
    'a frame over the limit only through escaped characters',
    line({ ...handover, payload: { text: '"'.repeat(51_200) } }),
    { kind: 'refused', reason: 'The frame is larger than 102400 bytes.' },
  ],
  [
    'a frame without its newline',
    bytes(JSON.stringify(handover)),
    { kind: 'refused', reason: 'The frame does not end with a newline.' },
  ],
  [
    'a second frame',
    bytes(`${JSON.stringify(handover)}\n${JSON.stringify(handover)}\n`),
    { kind: 'refused', reason: 'The connection carries more than one frame.' },
  ],
  [
    'invalid UTF-8',
    new Uint8Array([0xff, 0xfe, 0x0a]),
    { kind: 'refused', reason: 'The frame is not valid UTF-8.' },
  ],
  [
    'invalid JSON',
    bytes('{"protocol":\n'),
    { kind: 'refused', reason: 'The frame is not valid JSON.' },
  ],
  [
    'an unknown protocol',
    line({ ...handover, protocol: 'rpc2' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an unknown field',
    line({ ...handover, sender: 't2' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an unknown family',
    line({ ...handover, family: 'note' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a message ID that is not a UUID',
    line({ ...handover, messageId: '../escape' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'an answer payload with a handover family',
    line({ ...answer, family: 'handover' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
  [
    'a JSON value that is not an object',
    line(['hello']),
    { kind: 'refused', reason: 'The frame is not an rpc1 request.' },
  ],
];

it.each(requestCases)('decodes %s', (_name, input, expected) => {
  expect(decodeRequest(input)).toEqual(expected);
});

const queued = { protocol: 'rpc1', kind: 'queued', messageId, terminal: 't1', sessionId } as const;

const replyCases: [string, Uint8Array, ReturnType<typeof decodeReply>][] = [
  ['a queued reply', line(queued), { kind: 'frame', value: queued }],
  [
    'a queued reply from a custom Pi session ID',
    line({ ...queued, sessionId: 'job-1' }),
    { kind: 'frame', value: { ...queued, sessionId: 'job-1' } },
  ],
  [
    'a queued reply from a session ID that Pi does not accept',
    line({ ...queued, sessionId: '../escape' }),
    { kind: 'refused', reason: 'The frame is not an rpc1 reply.' },
  ],
  [
    'a refused reply',
    line(refusedReply('No handler.', messageId)),
    {
      kind: 'frame',
      value: { protocol: 'rpc1', kind: 'refused', reason: 'No handler.', messageId },
    },
  ],
  [
    'a reply over 4096 bytes',
    line(refusedReply('a'.repeat(4096))),
    { kind: 'refused', reason: 'The frame is larger than 4096 bytes.' },
  ],
  [
    'a queued reply with an unknown field',
    line({ ...queued, families: ['handover'] }),
    { kind: 'refused', reason: 'The frame is not an rpc1 reply.' },
  ],
];

it.each(replyCases)('decodes %s', (_name, input, expected) => {
  expect(decodeReply(input)).toEqual(expected);
});

const answerRequestFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'answerRequest', name), 'utf8'),
  ) as unknown;

it('decodes the frozen answer-request frames', () => {
  const request = answerRequestFixture('request.json');

  expect(decodeRequest(line(request))).toEqual({ kind: 'frame', value: request });

  for (const name of ['queued.json', 'refused.json', 'unknown.json']) {
    const reply = answerRequestFixture(name);

    expect(decodeReply(line(reply))).toEqual({ kind: 'frame', value: reply });
  }
});

it('refuses an answer-request payload with an extra field', () => {
  const request = answerRequestFixture('request.json') as { payload: Record<string, unknown> };

  const withParentSession = {
    ...request,
    payload: { ...request.payload, parentSession: 'manager-session' },
  };

  expect(decodeRequest(line(withParentSession))).toEqual({
    kind: 'refused',
    reason: 'The frame is not an rpc1 request.',
  });
});

const handoverQuestionFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'handoverQuestion', name), 'utf8'),
  ) as unknown;

it('decodes a pinned handover-question frame', () => {
  const request = handoverQuestionFixture('request.json');

  expect(decodeRequest(line(request))).toEqual({ kind: 'frame', value: request });
});

it('refuses a handover-question payload with an extra field', () => {
  const request = handoverQuestionFixture('request.json') as { payload: Record<string, unknown> };

  const withExtraField = {
    ...request,
    payload: { ...request.payload, sender: 'lead' },
  };

  const decision = decodeRequest(line(withExtraField));
  const reason = decision.kind === 'refused' ? decision.reason : '';

  expect(decision.kind).toBe('refused');
  expect(reason.length).toBeGreaterThan(0);
});

const handoverAnswerFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'handoverAnswer', name),
      'utf8',
    ),
  ) as unknown;

it('decodes the handover-answer frame fixture', () => {
  const request = handoverAnswerFixture('request.json');

  expect(decodeRequest(line(request))).toEqual({ kind: 'frame', value: request });
});

it.each([
  ['an extra payload field', { extra: true }],
  ['an empty answer', { answer: '' }],
  ['a question ID that is not a UUID', { questionId: 'question-1' }],
])('refuses a handover-answer frame with %s', (_name, override) => {
  const request = handoverAnswerFixture('request.json') as {
    payload: Record<string, unknown>;
  };

  const frame = { ...request, payload: { ...request.payload, ...override } };

  expect(decodeRequest(line(frame))).toEqual({
    kind: 'refused',
    reason: 'The frame is not an rpc1 request.',
  });
});

it('refuses an unknown reply without a reason', () => {
  const { reason: _reason, ...reply } = answerRequestFixture('unknown.json') as Record<
    string,
    unknown
  >;

  expect(decodeReply(line(reply))).toEqual({
    kind: 'refused',
    reason: 'The frame is not an rpc1 reply.',
  });
});

it('accepts a frame of exactly 102400 bytes', () => {
  const overhead = line({ ...handover, payload: { text: '' } }).length;
  const exact = { ...handover, payload: { text: 'a'.repeat(102_400 - overhead) } };
  const input = line(exact);

  expect(input.length).toBe(102_400);
  expect(decodeRequest(input)).toEqual({ kind: 'frame', value: exact });
});

it('leaves an invalid message ID out of a refusal', () => {
  expect(refusedReply('Malformed.', 'not-a-uuid')).toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'Malformed.',
  });
});

it('encodes one newline-terminated frame that decodes back', () => {
  expect(decodeRequest(bytes(encodeFrame(handover)))).toEqual({ kind: 'frame', value: handover });
});

const labelCases: [string, string, ReturnType<typeof parseInboxLabel>][] = [
  ['an rpc1 socket', 'rpc1:/tmp/tau-1000/a.sock', { kind: 'socket', path: '/tmp/tau-1000/a.sock' }],
  ['another protocol', 'rpc2:/tmp/tau-1000/a.sock', { kind: 'unsupported', protocol: 'rpc2' }],
  [
    'a legacy label without a protocol',
    'subscribed',
    { kind: 'unsupported', protocol: 'subscribed' },
  ],
  ['a relative path', 'rpc1:a.sock', { kind: 'unsupported', protocol: 'rpc1' }],
];

it.each(labelCases)('parses an inbox label with %s', (_name, value, expected) => {
  expect(parseInboxLabel(value)).toEqual(expected);
});

it('formats the label that parses back to the socket path', () => {
  expect(parseInboxLabel(formatInboxLabel('/tmp/tau-1000/a.sock'))).toEqual({
    kind: 'socket',
    path: '/tmp/tau-1000/a.sock',
  });
});
