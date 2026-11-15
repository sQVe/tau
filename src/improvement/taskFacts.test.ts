import { describe, expect, it } from 'vitest';

import { countTaskFacts, extractTaskEvidence } from './taskFacts.ts';
import type { TaskFact } from './taskFacts.ts';
import type { CallResult, ToolCall } from './transcript.ts';

const repository = 'github.com/sQVe/tau';
const ok: CallResult = { error: undefined, details: undefined };

const failed = (details?: Record<string, unknown>): CallResult => ({ error: 'failed', details });

const done = (details: Record<string, unknown>): CallResult => ({ error: undefined, details });

const call = (
  tool: string,
  parameters: Record<string, unknown> | undefined,
  result: CallResult | undefined = ok,
  viaCodemode = false,
): ToolCall => ({
  entryId: 'e1',
  callId: 'c1',
  timestamp: '2026-11-02T18:00:00.000Z',
  tool,
  arguments: parameters,
  viaCodemode,
  result,
});

const summary = (fact: TaskFact) => {
  if (fact.kind === 'publication') {
    return `publication ${fact.repository}#${fact.pr}`;
  }

  if (fact.kind === 'feedbackRound') {
    return `feedbackRound #${fact.pr}`;
  }

  return fact.kind === 'launch'
    ? `launch ${fact.profile ?? '?'} ${fact.workerId ?? '?'}`
    : fact.kind;
};

const assignment = '/home/a/.pi/agent/tau/main-1/assignments/8f9d646e/assignment.json';
const verify = { action: 'verify', repository, pr: 560 };

const table: { rule: string; call: ToolCall; facts: string[]; missing: string[][] }[] = [
  {
    rule: 'a verified pull request is a publication',
    call: call('pr', verify, done({ matches: true })),
    facts: [`publication ${repository}#560`],
    missing: [],
  },
  {
    rule: 'a verify whose body does not match is still a publication',
    call: call('pr', verify, done({ matches: false })),
    facts: [`publication ${repository}#560`],
    missing: [],
  },
  {
    rule: 'a nested verify that succeeded is a publication',
    call: call('pr', verify, ok, true),
    facts: [`publication ${repository}#560`],
    missing: [],
  },
  {
    rule: 'a verify without a result is no publication',
    call: { ...call('pr', verify), result: undefined },
    facts: [],
    missing: [],
  },
  {
    rule: 'a verify that failed is no publication',
    call: call('pr', verify, failed()),
    facts: [],
    missing: [],
  },
  {
    rule: 'a verify without a numeric pr is missing evidence',
    call: call('pr', { action: 'verify', repository, pr: '560' }),
    facts: [],
    missing: [['publication']],
  },
  {
    rule: 'a verify without a repository is missing evidence',
    call: call('pr', { action: 'verify', pr: 560 }),
    facts: [],
    missing: [['publication']],
  },
  {
    rule: 'a pr action that is no fact is ignored',
    call: call('pr', { action: 'evidence' }),
    facts: [],
    missing: [],
  },
  {
    rule: 'an unknown pr action is missing evidence',
    call: call('pr', { action: 'create' }),
    facts: [],
    missing: [['publication']],
  },
  {
    rule: 'nested pr arguments that are cut are missing evidence',
    call: call('pr', undefined, ok, true),
    facts: [],
    missing: [['publication']],
  },
  {
    rule: 'a working tree capture is a review capture',
    call: call('code_review', { action: 'capture', target: { kind: 'workingTree' } }),
    facts: ['reviewCapture'],
    missing: [],
  },
  {
    rule: 'a range capture is a review capture',
    call: call('code_review', { action: 'capture', target: { kind: 'range' } }),
    facts: ['reviewCapture'],
    missing: [],
  },
  {
    rule: 'a fix capture is a fix capture',
    call: call('code_review', { action: 'capture', target: { kind: 'fix' } }),
    facts: ['fixCapture'],
    missing: [],
  },
  {
    rule: 'a capture that failed is no capture',
    call: call('code_review', { action: 'capture', target: { kind: 'fix' } }, failed()),
    facts: [],
    missing: [],
  },
  {
    rule: 'a capture without a target kind is missing evidence for both captures',
    call: call('code_review', { action: 'capture', target: 'fix' }),
    facts: [],
    missing: [['reviewCapture', 'fixCapture']],
  },
  {
    rule: 'a code_review prepare is ignored',
    call: call('code_review', { action: 'prepare' }),
    facts: [],
    missing: [],
  },
  {
    rule: 'a pr_feedback read is one round for its pull request',
    call: call('pr_feedback', { action: 'read', repository, pr: 562 }, ok, true),
    facts: ['feedbackRound #562'],
    missing: [],
  },
  {
    rule: 'a pr_feedback read without a pr is missing evidence',
    call: call('pr_feedback', { action: 'read', repository }),
    facts: [],
    missing: [['feedbackRound']],
  },
  {
    rule: 'a pr_feedback checks is ignored',
    call: call('pr_feedback', { action: 'checks', repository, pr: 562 }),
    facts: [],
    missing: [],
  },
  {
    rule: 'a full check that did not pass is a failure',
    call: call('full_check', {}, done({ passed: false })),
    facts: ['checkFailure'],
    missing: [],
  },
  {
    rule: 'a full check error that did not pass is a failure',
    call: call('full_check', {}, failed({ passed: false })),
    facts: ['checkFailure'],
    missing: [],
  },
  {
    rule: 'a full check that passed is no failure',
    call: call('full_check', {}, done({ passed: true })),
    facts: [],
    missing: [],
  },
  {
    rule: 'a full check error without an outcome is ignored',
    call: call('full_check', {}, failed()),
    facts: [],
    missing: [],
  },
  {
    rule: 'a full check result without a passed flag is missing evidence',
    call: call('full_check', {}, done({ passed: 'no' })),
    facts: [],
    missing: [['checkFailure']],
  },
  {
    rule: 'a nested full check that succeeded has an unknown outcome',
    call: call('full_check', {}, ok, true),
    facts: [],
    missing: [['checkFailure']],
  },
  {
    rule: 'an old launch names its worker by task ID',
    call: call('subagent', { profile: 'qa' }, done({ taskId: 'task-1' })),
    facts: ['launch qa task-1'],
    missing: [],
  },
  {
    rule: 'a current launch names its worker by the assignment folder and its profile by label',
    call: call(
      'subagent',
      {},
      done({ labels: { 'tau.assignment': assignment, 'tau.profile': 'qa' } }),
    ),
    facts: ['launch qa 8f9d646e'],
    missing: [],
  },
  {
    rule: 'a launch whose result names no worker is missing a worker ID',
    call: call('subagent', { profile: 'worker' }, done({ state: 'live' })),
    facts: ['launch worker ?'],
    missing: [['workerId']],
  },
  {
    rule: 'a nested launch has an unknown worker ID',
    call: call('subagent', { profile: 'qa' }, ok, true),
    facts: ['launch qa ?'],
    missing: [['workerId']],
  },
  {
    rule: 'a launch without a profile is missing evidence for QA launches',
    call: call('subagent', undefined, done({ taskId: 'task-1' })),
    facts: ['launch ? task-1'],
    missing: [['qaLaunch']],
  },
  {
    rule: 'a launch that failed is no launch',
    call: call('subagent', { profile: 'qa' }, failed()),
    facts: [],
    missing: [],
  },
  {
    rule: 'a tool that holds no fact is ignored',
    call: call('bash', undefined),
    facts: [],
    missing: [],
  },
];

describe('extractTaskEvidence', () => {
  it.each(table)('$rule', ({ call: toolCall, facts, missing }) => {
    const evidence = extractTaskEvidence([toolCall]);

    expect(evidence.facts.map(summary)).toEqual(facts);
    expect(evidence.missing.map((item) => item.affects)).toEqual(missing);
  });

  it('names the tool, entry, and reason of missing evidence', () => {
    const evidence = extractTaskEvidence([call('pr', { action: 'verify', pr: 560 })]);

    expect(evidence.missing).toEqual([
      {
        tool: 'pr',
        entryId: 'e1',
        callId: 'c1',
        timestamp: '2026-11-02T18:00:00.000Z',
        reason: 'verify has no repository or numeric pr.',
        affects: ['publication'],
      },
    ]);
  });
});

describe('countTaskFacts', () => {
  it('counts each fact kind', () => {
    const evidence = extractTaskEvidence([
      call('code_review', { action: 'capture', target: { kind: 'workingTree' } }),
      call('code_review', { action: 'capture', target: { kind: 'fix' } }),
      call('pr_feedback', { action: 'read', repository, pr: 560 }),
      call('pr_feedback', { action: 'read', repository, pr: 560 }),
      call('full_check', {}, done({ passed: false })),
      call('subagent', { profile: 'qa' }, done({ taskId: 'task-1' })),
      call('subagent', { profile: 'worker' }, done({ taskId: 'task-2' })),
      call('pr', verify),
    ]);

    expect(countTaskFacts(evidence)).toEqual({
      publications: 1,
      reviewCaptures: 1,
      fixCaptures: 1,
      feedbackRounds: 2,
      checkFailures: 1,
      qaLaunches: 1,
      launches: 2,
    });
  });

  it('makes a count unknown, not zero, when a known tool has an unknown call shape', () => {
    const evidence = extractTaskEvidence([
      call('code_review', { action: 'capture', target: { kind: 'workingTree' } }),
      call('code_review', { action: 'capture' }),
      call('full_check', {}, ok, true),
    ]);

    expect(evidence.missing.map((item) => [item.tool, item.entryId])).toEqual([
      ['code_review', 'e1'],
      ['full_check', 'e1'],
    ]);

    expect(countTaskFacts(evidence)).toEqual({
      publications: 0,
      reviewCaptures: 'unknown',
      fixCaptures: 'unknown',
      feedbackRounds: 0,
      checkFailures: 'unknown',
      qaLaunches: 0,
      launches: 0,
    });
  });
});
