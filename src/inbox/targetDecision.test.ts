import { expect, it } from 'vitest';

import { decideTarget } from './targetDecision.js';
import type { TargetFacts } from './targetDecision.js';

const sessionId = '0190c1d2-0000-7000-8000-000000000002';

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
    { kind: 'connect', path: `/tmp/tau-1000/${sessionId}.sock`, sessionId },
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
  [
    'a session socket without the .sock suffix',
    { ...target, labels: { 'tau.inbox': `rpc1:/tmp/tau-1000/${sessionId}.json` } },
    { kind: 'refuse', reason: 'Terminal t1 advertises a socket without a session.' },
  ],
  [
    'a socket not named after a session',
    { ...target, labels: { 'tau.inbox': 'rpc1:/tmp/tau-1000/a.sock' } },
    { kind: 'refuse', reason: 'Terminal t1 advertises a socket without a session.' },
  ],
];

it.each(targetCases)('decides a target for %s', (_name, facts, expected) => {
  expect(decideTarget(facts)).toEqual(expected);
});
