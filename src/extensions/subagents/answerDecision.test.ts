import { expect, it } from 'vitest';

import {
  decideAssignment,
  decideTarget,
  leaseRefusal,
  targetChangeRefusal,
} from './answerDecision.js';
import type {
  AssignmentDecision,
  AssignmentFact,
  TargetDecision,
  TargetTerminal,
} from './answerDecision.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';

const assignmentId = '11111111-1111-4111-8111-111111111111';
const otherAssignmentId = '22222222-2222-4222-8222-222222222222';
const firstQuestionId = '33333333-3333-4333-8333-333333333333';
const openQuestionId = '44444444-4444-4444-8444-444444444444';
const workerSessionId = '55555555-5555-4555-8555-555555555555';
const otherSessionId = '66666666-6666-4666-8666-666666666666';
const path = `/agent/assignments/${assignmentId}/assignment.json`;
const parentSession = '/work/parent.jsonl';
const manager = 't-manager';

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  version: 3,
  assignmentId,
  task: 'Inspect the counters.',
  acceptance: [],
  label: null,
  profile: 'worker',
  loadout: fixtureLoadout('/work'),
  routing: null,
  packageSnapshot: null,
  session: { id: workerSessionId, file: `/agent/assignments/${assignmentId}/session.jsonl` },
  parentSession,
  cwd: '/work',
  parentTerminal: manager,
  deadline: 2,
  createdAt: 1,
  previousAssignmentId: null,
  extensionPackages: [],
  questions: [
    { questionId: firstQuestionId, text: 'Which file?', askedAt: 1 },
    { questionId: openQuestionId, text: 'Which counter?', askedAt: 2 },
  ],
  report: null,
  ...overrides,
});

const saved = (overrides: Partial<Assignment> = {}): AssignmentFact => ({
  kind: 'saved',
  assignment: assignment(overrides),
});

const refused = (reason: string): AssignmentDecision => ({
  kind: 'refused',
  reason: `${reason} No answer was saved.`,
});

it.each<{ name: string; read: AssignmentFact; questionId?: string; expected: AssignmentDecision }>([
  {
    name: 'the open question of an owned assignment',
    read: saved(),
    expected: { kind: 'answerable', assignment: assignment() },
  },
  {
    name: 'a missing assignment',
    read: { kind: 'missing' },
    expected: refused(`Missing assignment ${path}.`),
  },
  {
    name: 'a malformed assignment',
    read: { kind: 'malformed', message: 'Malformed assignment.' },
    expected: refused('Malformed assignment.'),
  },
  {
    name: 'a mismatched assignment ID',
    read: saved({ assignmentId: otherAssignmentId }),
    expected: refused(`${path} names assignment ${otherAssignmentId}, not ${assignmentId}.`),
  },
  {
    name: "another manager's assignment",
    read: saved({ parentSession: '/work/other.jsonl' }),
    expected: refused(`Assignment ${assignmentId} belongs to another manager session.`),
  },
  {
    name: 'a reported assignment',
    read: saved({ report: { outcome: 'success', summary: 'Done.', evidence: [] } }),
    expected: refused(`Assignment ${assignmentId} already has a report.`),
  },
  {
    name: 'an assignment without questions',
    read: saved({ questions: [] }),
    expected: refused(`Assignment ${assignmentId} has no saved question.`),
  },
  {
    name: 'an earlier question',
    read: saved(),
    questionId: firstQuestionId,
    expected: refused(
      `Question ${firstQuestionId} is not the open question of assignment ${assignmentId}; the open question is ${openQuestionId}.`,
    ),
  },
])('decides the assignment for $name', ({ read, questionId, expected }) => {
  expect(
    decideAssignment({
      assignmentId,
      questionId: questionId ?? openQuestionId,
      path,
      parentSession,
      read,
    }),
  ).toEqual(expected);
});

const terminal = (overrides: Partial<TargetTerminal> = {}): TargetTerminal => ({
  address: 't-worker',
  state: 'live',
  parent: manager,
  labels: { 'tau.assignment': path },
  ...overrides,
});

const noTarget: TargetDecision = {
  kind: 'refused',
  reason: `No live worker terminal of ${manager} carries assignment ${path}. No answer was saved.`,
};

it.each<{ name: string; terminals: TargetTerminal[]; expected: TargetDecision }>([
  {
    name: 'one live child',
    terminals: [terminal()],
    expected: { kind: 'target', terminal: 't-worker' },
  },
  { name: 'no terminals', terminals: [], expected: noTarget },
  { name: 'a finished child', terminals: [terminal({ state: 'finished' })], expected: noTarget },
  {
    name: "another manager's child",
    terminals: [terminal({ parent: 't-other' })],
    expected: noTarget,
  },
  { name: 'a child without a parent', terminals: [terminal({ parent: null })], expected: noTarget },
  {
    name: 'a child of another assignment',
    terminals: [terminal({ labels: { 'tau.assignment': '/elsewhere/assignment.json' } })],
    expected: noTarget,
  },
  {
    name: 'a child without labels',
    terminals: [terminal({ labels: undefined })],
    expected: noTarget,
  },
  {
    name: 'one match beside other terminals',
    terminals: [terminal({ address: 't-other', parent: 't-other' }), terminal()],
    expected: { kind: 'target', terminal: 't-worker' },
  },
  {
    name: 'several matches',
    terminals: [terminal(), terminal({ address: 't-second' })],
    expected: {
      kind: 'refused',
      reason: `Several live worker terminals carry assignment ${path}: t-worker, t-second. No answer was saved.`,
    },
  },
])('decides the target for $name', ({ terminals, expected }) => {
  expect(decideTarget({ managerTerminal: manager, path, terminals })).toEqual(expected);
});

const changed = (problem: string): string =>
  `Worker terminal t-worker changed before the answer was saved: ${problem}. No answer was saved.`;

it.each<{ name: string; reread: TargetTerminal; expected: string | undefined }>([
  { name: 'an unchanged terminal', reread: terminal(), expected: undefined },
  {
    name: 'a finished terminal',
    reread: terminal({ state: 'finished' }),
    expected: changed('it is not live'),
  },
  {
    name: 'a new parent',
    reread: terminal({ parent: 't-other' }),
    expected: changed(`its parent is t-other, not ${manager}`),
  },
  {
    name: 'a removed parent',
    reread: terminal({ parent: undefined }),
    expected: changed(`its parent is none, not ${manager}`),
  },
  {
    name: 'a new assignment label',
    reread: terminal({ labels: { 'tau.assignment': '/elsewhere/assignment.json' } }),
    expected: changed(`its tau.assignment label is /elsewhere/assignment.json, not ${path}`),
  },
  {
    name: 'a removed assignment label',
    reread: terminal({ labels: {} }),
    expected: changed(`its tau.assignment label is missing, not ${path}`),
  },
])('decides the reread of $name', ({ reread, expected }) => {
  expect(targetChangeRefusal({ managerTerminal: manager, path, terminal: reread })).toBe(expected);
});

it.each([
  { name: 'the worker session', leaseSessionId: workerSessionId, expected: undefined },
  {
    name: 'another session',
    leaseSessionId: otherSessionId,
    expected: `t-worker has inbox session ${otherSessionId}, not worker session ${workerSessionId}. No answer was saved.`,
  },
])('decides a lease that names $name', ({ leaseSessionId, expected }) => {
  expect(leaseRefusal({ terminal: 't-worker', leaseSessionId, workerSessionId })).toBe(expected);
});
