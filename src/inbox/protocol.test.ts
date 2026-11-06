import { expect, it } from 'vitest';

import {
  decodeReply,
  decodeRequest,
  encodeFrame,
  formatInboxLabel,
  parseInboxLabel,
  refusedReply,
} from './protocol.js';
import type { ReadyReply } from './protocol.js';

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

const answer = {
  ...handover,
  family: 'answer',
  payload: { assignmentId, questionId, parentSession: 'manager-session', answer: 'Use option A.' },
} as const;

const hello = { protocol: 'rpc1', kind: 'hello' } as const;

const requestCases: [string, Uint8Array, ReturnType<typeof decodeRequest>][] = [
  ['a hello', line(hello), { kind: 'frame', value: hello }],
  ['a handover message', line(handover), { kind: 'frame', value: handover }],
  ['an answer message', line(answer), { kind: 'frame', value: answer }],
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
    bytes(JSON.stringify(hello)),
    { kind: 'refused', reason: 'The frame does not end with a newline.' },
  ],
  [
    'a second frame',
    bytes(`${JSON.stringify(hello)}\n${JSON.stringify(hello)}\n`),
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
    line({ ...hello, protocol: 'rpc2' }),
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

const ready: ReadyReply = {
  protocol: 'rpc1',
  kind: 'ready',
  terminal: 't1',
  sessionId,
  families: ['handover'],
};

const queued = { protocol: 'rpc1', kind: 'queued', messageId, terminal: 't1', sessionId } as const;

const replyCases: [string, Uint8Array, ReturnType<typeof decodeReply>][] = [
  ['a ready reply', line(ready), { kind: 'frame', value: ready }],
  ['a queued reply', line(queued), { kind: 'frame', value: queued }],
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
    'a ready reply with an unknown family',
    line({ ...ready, families: ['note'] }),
    { kind: 'refused', reason: 'The frame is not an rpc1 reply.' },
  ],
];

it.each(replyCases)('decodes %s', (_name, input, expected) => {
  expect(decodeReply(input)).toEqual(expected);
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
  expect(decodeRequest(bytes(encodeFrame(hello)))).toEqual({ kind: 'frame', value: hello });
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
