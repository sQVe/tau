import { expect, it } from 'vitest';

import {
  deadlineWarningDelay,
  deadlineWarningReserve,
  decideDeadline,
  retryDelay,
  reuseArmedTimer,
} from './deadlineDecision.js';
import type {
  DeadlineAssignment,
  DeadlineChildFact,
  DeadlineFacts,
  DeadlineKill,
  DeadlinePlan,
  DeadlineTimer,
} from './deadlineDecision.js';

const manager = 't-manager';
const now = 1_000_000;
const path = '/agent/assignment.json';
const assignmentId = '11111111-1111-1111-1111-111111111111';
const parentSession = '/sessions/manager.jsonl';
const reserve = deadlineWarningReserve;

const saved = (deadline: number, reported = false): DeadlineAssignment => ({
  kind: 'saved',
  path,
  assignmentId,
  parentSession,
  deadline,
  reported,
});

const timer = (killAt: number): DeadlineTimer => ({
  address: 't-child',
  assignmentPath: path,
  assignmentId,
  parentSession,
  killAt,
});

const kill = (withAssignment = true): DeadlineKill => ({
  address: 't-child',
  assignmentPath: path,
  ...(withAssignment ? { assignmentId, parentSession } : {}),
});

const labelError = (label: string | undefined, deadline: number): string =>
  label === undefined
    ? `Worker ${assignmentId} has no tau.deadline label; using the assignment deadline ${deadline}.`
    : `Worker ${assignmentId} has tau.deadline label "${label}"; using the assignment deadline ${deadline}.`;

const label = (labelValue: string | undefined): Record<string, string> => ({
  'tau.assignment': path,
  ...(labelValue === undefined ? {} : { 'tau.deadline': labelValue }),
});

const child = (
  deadline: number,
  options: {
    assignment?: DeadlineAssignment;
    labels?: Record<string, string> | undefined;
    parent?: string | undefined;
    state?: string;
    address?: string;
  } = {},
): DeadlineChildFact => ({
  address: options.address ?? 't-child',
  parent: options.parent ?? manager,
  state: options.state ?? 'live',
  labels: 'labels' in options ? options.labels : label(String(deadline)),
  assignment: options.assignment ?? saved(deadline),
});

const facts = (...children: DeadlineChildFact[]): DeadlineFacts => ({
  managerTerminal: manager,
  now,
  children,
});

it.each<{ name: string; given: DeadlineFacts; expected: DeadlinePlan }>([
  {
    name: 'arms a future deadline',
    given: facts(child(now + 600_000)),
    expected: { armed: [timer(now + 600_000)], kills: [], errors: [] },
  },
  {
    name: 'kills a passed deadline at once',
    given: facts(child(now - 1)),
    expected: { armed: [], kills: [kill()], errors: [] },
  },
  {
    name: 'kills at the deadline exactly',
    given: facts(child(now)),
    expected: { armed: [], kills: [kill()], errors: [] },
  },
  {
    name: 'arms a near deadline',
    given: facts(child(now + 30_000)),
    expected: { armed: [timer(now + 30_000)], kills: [], errors: [] },
  },
  {
    name: 'arms a deadline at the reserve',
    given: facts(child(now + reserve)),
    expected: { armed: [timer(now + reserve)], kills: [], errors: [] },
  },
  {
    name: 'arms nothing for a saved report',
    given: facts(child(now + 600_000, { assignment: saved(now + 600_000, true) })),
    expected: { armed: [], kills: [], errors: [] },
  },
  {
    name: 'skips a child with no label',
    given: facts(child(now + 600_000, { labels: {} })),
    expected: { armed: [], kills: [], errors: [] },
  },
  {
    name: 'skips an empty assignment label',
    given: facts(
      child(now + 600_000, {
        labels: { 'tau.assignment': '', 'tau.deadline': String(now + 600_000) },
      }),
    ),
    expected: { armed: [], kills: [], errors: [] },
  },
  {
    name: 'skips a child with no labels',
    given: facts(child(now + 600_000, { labels: undefined })),
    expected: { armed: [], kills: [], errors: [] },
  },
  {
    name: 'kills a missing assignment at once',
    given: facts(child(now + 600_000, { assignment: { kind: 'missing', path } })),
    expected: {
      armed: [],
      kills: [kill(false)],
      errors: [{ key: `assignment:${path}`, message: `Missing assignment file: ${path}.` }],
    },
  },
  {
    name: 'kills a malformed report at once',
    given: facts(
      child(now + 600_000, {
        assignment: { kind: 'malformed', path, message: `Malformed assignment ${path}: not JSON.` },
      }),
    ),
    expected: {
      armed: [],
      kills: [kill(false)],
      errors: [{ key: `assignment:${path}`, message: `Malformed assignment ${path}: not JSON.` }],
    },
  },
  {
    name: 'reports an unread child',
    given: facts(
      child(now + 600_000, {
        assignment: { kind: 'unread', message: 'Reading t-child failed: boom' },
      }),
    ),
    expected: {
      armed: [],
      kills: [],
      errors: [{ key: 'unread:t-child', message: 'Reading t-child failed: boom' }],
    },
  },
  {
    name: 'reports a missing deadline label',
    given: facts(child(now + 600_000, { labels: label(undefined) })),
    expected: {
      armed: [timer(now + 600_000)],
      kills: [],
      errors: [{ key: `label:${assignmentId}`, message: labelError(undefined, now + 600_000) }],
    },
  },
  {
    name: 'reports a malformed deadline label',
    given: facts(child(now + 600_000, { labels: label('soon') })),
    expected: {
      armed: [timer(now + 600_000)],
      kills: [],
      errors: [{ key: `label:${assignmentId}`, message: labelError('soon', now + 600_000) }],
    },
  },
  {
    name: 'reports a differing deadline label',
    given: facts(child(now + 600_000, { labels: label(String(now + 900_000)) })),
    expected: {
      armed: [timer(now + 600_000)],
      kills: [],
      errors: [
        { key: `label:${assignmentId}`, message: labelError(String(now + 900_000), now + 600_000) },
      ],
    },
  },
  {
    name: 'reports a label error then kills',
    given: facts(child(now - 1, { labels: label('soon') })),
    expected: {
      armed: [],
      kills: [kill()],
      errors: [{ key: `label:${assignmentId}`, message: labelError('soon', now - 1) }],
    },
  },
  {
    name: "ignores another manager's child",
    given: facts(child(now + 600_000, { parent: 't-elsewhere' })),
    expected: { armed: [], kills: [], errors: [] },
  },
  {
    name: 'ignores an ended child',
    given: facts(child(now + 600_000, { state: 'finished' })),
    expected: { armed: [], kills: [], errors: [] },
  },
])('$name', ({ given, expected }) => {
  expect(decideDeadline(given)).toStrictEqual(expected);
});

it.each<{ name: string; deadline: number; expected: number }>([
  {
    name: 'waits the reserve when more than the reserve is left',
    deadline: now + 120_000,
    expected: 30_000,
  },
  {
    name: 'warns at once with exactly the reserve left',
    deadline: now + reserve,
    expected: 0,
  },
  {
    name: 'warns at once with less than the reserve left',
    deadline: now + 30_000,
    expected: 0,
  },
  { name: 'warns at once after the deadline', deadline: now - 1, expected: 0 },
])('$name', ({ deadline, expected }) => {
  expect(deadlineWarningDelay(deadline, now)).toBe(expected);
});

it.each<{ name: string; attempt: number; expected: number | undefined }>([
  { name: 'waits 5 s after the first failure', attempt: 0, expected: 5_000 },
  { name: 'waits 15 s after the second failure', attempt: 1, expected: 15_000 },
  { name: 'waits 45 s after the third failure', attempt: 2, expected: 45_000 },
  { name: 'stops after the bounded schedule', attempt: 3, expected: undefined },
])('$name', ({ attempt, expected }) => {
  expect(retryDelay(attempt)).toBe(expected);
});

it.each<{
  name: string;
  current: { killAt: number } | undefined;
  next: { killAt: number };
  expected: boolean;
}>([
  {
    name: 'reuses an unchanged deadline',
    current: { killAt: now + 30_000 },
    next: { killAt: now + 30_000 },
    expected: true,
  },
  {
    name: 're-arms when the deadline changes',
    current: { killAt: now + 30_000 },
    next: { killAt: now + 60_000 },
    expected: false,
  },
  {
    name: 'arms when no timer exists',
    current: undefined,
    next: { killAt: now + 30_000 },
    expected: false,
  },
])('$name', ({ current, next, expected }) => {
  expect(reuseArmedTimer(current, next)).toBe(expected);
});
