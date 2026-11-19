import { expect, it } from 'vitest';

import { decideResume, decideShutdown, decideStart, needsResumeCheck } from './lockDecision.js';
import type {
  ResumeHolderFact,
  ResumePlan,
  ShutdownPlan,
  StartFacts,
  StartPlan,
} from './lockDecision.js';

const startTable: { name: string; facts: StartFacts; expected: StartPlan }[] = [
  {
    name: 'frees any held lock when the session has no file',
    facts: { hasSessionFile: false, heldLockPath: '/lock/a', lockPath: undefined },
    expected: 'release',
  },
  {
    name: 'keeps the lock this process holds for the same file',
    facts: { hasSessionFile: true, heldLockPath: '/lock/a', lockPath: '/lock/a' },
    expected: 'keep',
  },
  {
    name: 'takes the lock when none is held',
    facts: { hasSessionFile: true, heldLockPath: undefined, lockPath: '/lock/a' },
    expected: 'acquire',
  },
  {
    name: 'replaces the held lock when the file differs',
    facts: { hasSessionFile: true, heldLockPath: '/lock/a', lockPath: '/lock/b' },
    expected: 'acquire',
  },
];

it.for(startTable)('decides a start: $name', ({ facts, expected }) => {
  expect(decideStart(facts)).toBe(expected);
});

const shutdownTable: { reason: string; expected: ShutdownPlan }[] = [
  { reason: 'reload', expected: 'keep' },
  { reason: 'quit', expected: 'release' },
  { reason: 'new', expected: 'release' },
  { reason: 'resume', expected: 'release' },
  { reason: 'fork', expected: 'release' },
];

it.for(shutdownTable)('decides a $reason shutdown', ({ reason, expected }) => {
  expect(decideShutdown(reason)).toBe(expected);
});

const checkTable: {
  name: string;
  reason: string;
  target: string | undefined;
  expected: boolean;
}[] = [
  { name: 'a resume with a target', reason: 'resume', target: '/s.jsonl', expected: true },
  { name: 'a resume with no target', reason: 'resume', target: undefined, expected: false },
  { name: 'a new session with a target', reason: 'new', target: '/s.jsonl', expected: false },
];

it.for(checkTable)(
  'checks the target lock for $name: $expected',
  ({ reason, target, expected }) => {
    expect(needsResumeCheck(reason, target)).toBe(expected);
  },
);

const resumeTable: { name: string; fact: ResumeHolderFact; expected: ResumePlan }[] = [
  {
    name: 'allows a target nobody holds',
    fact: { read: 'ok', holderPid: undefined, ownPid: 10 },
    expected: 'allow',
  },
  {
    name: 'allows a target this process holds',
    fact: { read: 'ok', holderPid: 10, ownPid: 10 },
    expected: 'allow',
  },
  {
    name: 'refuses a target another process holds',
    fact: { read: 'ok', holderPid: 11, ownPid: 10 },
    expected: 'refuse',
  },
  {
    name: 'allows with a warning when the lock cannot be read',
    fact: { read: 'failed' },
    expected: 'allow-with-warning',
  },
];

it.for(resumeTable)('decides a resume: $name', ({ fact, expected }) => {
  expect(decideResume(fact)).toBe(expected);
});
