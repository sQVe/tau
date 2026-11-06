import { expect, it } from 'vitest';

import type { ReadyReply } from './protocol.js';
import { decideReady, decideTarget } from './targetDecision.js';
import type { ReadyExpectation, TargetFacts } from './targetDecision.js';

const sessionId = '0190c1d2-0000-7000-8000-000000000002';
const otherSessionId = '0190c1d2-0000-7000-8000-000000000009';

const target: TargetFacts = {
  address: 't1',
  state: 'live',
  labels: { 'tau.inbox': `rpc1:/tmp/tau-1000/${sessionId}.sock` },
  ownAddress: 't2',
};

const targetCases: [string, TargetFacts, ReturnType<typeof decideTarget>][] = [
  [
    'a live peer with an rpc1 label',
    target,
    { kind: 'connect', path: `/tmp/tau-1000/${sessionId}.sock` },
  ],
  [
    'a remote terminal',
    { ...target, address: 'machine/t1' },
    { kind: 'refuse', reason: 'Terminal machine/t1 is on another machine.' },
  ],
  [
    'the own terminal',
    { ...target, ownAddress: 't1' },
    { kind: 'refuse', reason: "Terminal t1 is this session's own terminal." },
  ],
  [
    'a finished terminal',
    { ...target, state: 'finished' },
    { kind: 'refuse', reason: 'Terminal t1 is finished, not live.' },
  ],
  [
    'a terminal without the label',
    { ...target, labels: {} },
    { kind: 'refuse', reason: 'Terminal t1 advertises no Tau inbox.' },
  ],
  [
    'a legacy label',
    { ...target, labels: { 'tau.inbox': 'subscribed' } },
    { kind: 'refuse', reason: 'Terminal t1 advertises inbox protocol "subscribed", not rpc1.' },
  ],
  [
    'an unsupported protocol',
    { ...target, labels: { 'tau.inbox': 'rpc2:/tmp/a.sock' } },
    { kind: 'refuse', reason: 'Terminal t1 advertises inbox protocol "rpc2", not rpc1.' },
  ],
];

it.each(targetCases)('decides a target for %s', (_name, facts, expected) => {
  expect(decideTarget(facts)).toEqual(expected);
});

const ready: ReadyReply = {
  protocol: 'rpc1',
  kind: 'ready',
  terminal: 't1',
  sessionId,
  families: ['handover'],
};

const expectation: ReadyExpectation = { address: 't1', sessionId, family: 'handover' };

const readyCases: [string, ReadyReply, ReadyExpectation, ReturnType<typeof decideReady>][] = [
  ['a matching peer', ready, expectation, { kind: 'send' }],
  [
    'a peer with no expected session',
    ready,
    { ...expectation, sessionId: undefined },
    { kind: 'send' },
  ],
  [
    'another terminal',
    { ...ready, terminal: 't3' },
    expectation,
    { kind: 'refuse', reason: 'The inbox of t1 answers for terminal t3.' },
  ],
  [
    'another session',
    { ...ready, sessionId: otherSessionId },
    expectation,
    {
      kind: 'refuse',
      reason: `The inbox of t1 belongs to session ${otherSessionId}, not ${sessionId}.`,
    },
  ],
  [
    'an unsupported family',
    ready,
    { ...expectation, family: 'answer' },
    { kind: 'refuse', reason: 'The inbox of t1 does not accept answer messages.' },
  ],
];

it.each(readyCases)('decides a handshake from %s', (_name, reply, expected, decision) => {
  expect(decideReady(reply, expected)).toEqual(decision);
});
