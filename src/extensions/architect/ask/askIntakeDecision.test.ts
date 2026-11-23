import { expect, it } from 'vitest';

import type { GateRecord, GateRecordRead } from '../record.js';
import { decideAskIntake } from './askIntakeDecision.js';
import type { AskIntakeDecision, AskIntakeFacts } from './askIntakeDecision.js';
import { gateRoutingQuestion } from './gateQuestion.js';

const gateRecord = (decision: GateRecord['decision']): GateRecord => ({
  version: 1,
  createdAt: '2026-11-18T10:00:00.000Z',
  request: 'Merge Koja PR #91 when every required check passes.',
  restatement: 'Merge PR #91 once its checks pass.',
  outcome: { kind: 'answered', label: decision, confidence: 0.5 },
  decision,
  label: decision,
  confidence: 0.5,
});

const found = (path: string, decision: GateRecord['decision']): GateRecordRead => ({
  kind: 'found',
  path,
  record: gateRecord(decision),
});

const table: {
  name: string;
  facts: AskIntakeFacts;
  expected: AskIntakeDecision;
}[] = [
  {
    name: 'retries an askId alone',
    facts: { askId: 'ask-id', question: undefined, gate: undefined, gateRead: undefined },
    expected: { kind: 'retry', askId: 'ask-id' },
  },
  {
    name: 'retries an askId with blank text',
    facts: { askId: 'ask-id', question: '  ', gate: '  ', gateRead: undefined },
    expected: { kind: 'retry', askId: 'ask-id' },
  },
  {
    name: 'refuses a question beside an askId',
    facts: { askId: 'ask-id', question: 'Which flag?', gate: undefined, gateRead: undefined },
    expected: {
      kind: 'refusal',
      message: 'action ask with askId does not take question.',
    },
  },
  {
    name: 'refuses a gate beside an askId',
    facts: { askId: 'ask-id', question: undefined, gate: 'gate.json', gateRead: undefined },
    expected: {
      kind: 'refusal',
      message: 'action ask with askId does not take gate.',
    },
  },
  {
    name: 'refuses a question and a gate',
    facts: {
      askId: undefined,
      question: 'Which flag?',
      gate: 'gate.json',
      gateRead: { kind: 'outside', directory: '/checkout/.tau/lead/gate' },
    },
    expected: {
      kind: 'refusal',
      message: 'action ask takes question or gate, not both.',
    },
  },
  {
    name: 'refuses neither a question nor a gate',
    facts: { askId: undefined, question: undefined, gate: undefined, gateRead: undefined },
    expected: { kind: 'refusal', message: 'question or gate is required.' },
  },
  {
    name: 'refuses a blank question and gate',
    facts: { askId: undefined, question: ' ', gate: ' ', gateRead: undefined },
    expected: { kind: 'refusal', message: 'question or gate is required.' },
  },
  {
    name: 'asks the supplied question',
    facts: { askId: undefined, question: 'Which flag?', gate: undefined, gateRead: undefined },
    expected: { kind: 'ask', question: 'Which flag?', gateRecord: null },
  },
  {
    name: 'refuses a gate outside the gate directory',
    facts: {
      askId: undefined,
      question: undefined,
      gate: '../gate.json',
      gateRead: { kind: 'outside', directory: '/checkout/.tau/lead/gate' },
    },
    expected: {
      kind: 'refusal',
      message: 'gate ../gate.json is not a gate record in /checkout/.tau/lead/gate.',
    },
  },
  {
    name: 'refuses a missing gate record',
    facts: {
      askId: undefined,
      question: undefined,
      gate: 'gate.json',
      gateRead: { kind: 'missing' },
    },
    expected: { kind: 'refusal', message: 'gate record gate.json does not exist.' },
  },
  {
    name: 'refuses a gate with no read fact',
    facts: {
      askId: undefined,
      question: undefined,
      gate: 'gate.json',
      gateRead: undefined,
    },
    expected: { kind: 'refusal', message: 'gate record gate.json does not exist.' },
  },
  {
    name: 'refuses an unreadable gate record with the reader message',
    facts: {
      askId: undefined,
      question: undefined,
      gate: 'gate.json',
      gateRead: {
        kind: 'unreadable',
        message: 'Malformed gate record /checkout/.tau/lead/gate/gate.json: not JSON.',
      },
    },
    expected: {
      kind: 'refusal',
      message: 'Malformed gate record /checkout/.tau/lead/gate/gate.json: not JSON.',
    },
  },
  {
    name: 'refuses a specified gate',
    facts: {
      askId: undefined,
      question: undefined,
      gate: 'gate.json',
      gateRead: found('/checkout/.tau/lead/gate/gate.json', 'specified'),
    },
    expected: {
      kind: 'refusal',
      message: 'gate record gate.json is specified, not uncertain. Follow it instead of asking.',
    },
  },
  {
    name: 'refuses an open gate',
    facts: {
      askId: undefined,
      question: undefined,
      gate: 'gate.json',
      gateRead: found('/checkout/.tau/lead/gate/gate.json', 'open'),
    },
    expected: {
      kind: 'refusal',
      message: 'gate record gate.json is open, not uncertain. Follow it instead of asking.',
    },
  },
  {
    name: 'asks the routing question for an uncertain gate',
    facts: {
      askId: undefined,
      question: undefined,
      gate: 'gate.json',
      gateRead: found('/checkout/.tau/lead/gate/gate.json', 'uncertain'),
    },
    expected: {
      kind: 'ask',
      question: gateRoutingQuestion(gateRecord('uncertain')),
      gateRecord: '/checkout/.tau/lead/gate/gate.json',
    },
  },
  {
    name: 'refuses a question beside an askId before a gate outside',
    facts: {
      askId: 'ask-id',
      question: 'Which flag?',
      gate: '../gate.json',
      gateRead: { kind: 'outside', directory: '/checkout/.tau/lead/gate' },
    },
    expected: {
      kind: 'refusal',
      message: 'action ask with askId does not take question.',
    },
  },
  {
    name: 'refuses a gate beside an askId before a missing record',
    facts: {
      askId: 'ask-id',
      question: undefined,
      gate: 'gate.json',
      gateRead: { kind: 'missing' },
    },
    expected: {
      kind: 'refusal',
      message: 'action ask with askId does not take gate.',
    },
  },
  {
    name: 'refuses both a question and a gate before a missing record',
    facts: {
      askId: undefined,
      question: 'Which flag?',
      gate: 'gate.json',
      gateRead: { kind: 'missing' },
    },
    expected: {
      kind: 'refusal',
      message: 'action ask takes question or gate, not both.',
    },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(decideAskIntake(facts)).toStrictEqual(expected);
});
