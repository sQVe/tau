import { describe, expect, it } from 'vitest';

import { keepFactCalls } from './taskFacts.ts';
import type { CallResult, ToolCall } from './transcript.ts';

const call = (
  tool: string,
  parameters: Record<string, unknown> | undefined,
  result: CallResult | undefined,
  viaCodemode = false,
): ToolCall => ({
  entryId: 'e1',
  callId: 'c1',
  timestamp: '2026-11-02T18:00:00.000Z',
  tool,
  viaCodemode,
  ...(parameters === undefined ? {} : { arguments: parameters }),
  ...(result === undefined ? {} : { result }),
});

const result = (fields: { error?: string; details?: Record<string, unknown> }): CallResult => ({
  ...(fields.error === undefined ? {} : { error: fields.error }),
  ...(fields.details === undefined ? {} : { details: fields.details }),
});

const withoutArguments = (tool: string): ToolCall => ({
  entryId: 'e1',
  callId: 'c1',
  timestamp: '2026-11-02T18:00:00.000Z',
  tool,
  viaCodemode: false,
});

const longError = 'x'.repeat(250);

const table: { rule: string; call: ToolCall; kept: ToolCall[] }[] = [
  {
    rule: 'keeps a pr call and strips its arguments and details',
    call: call(
      'pr',
      { action: 'verify', repository: 'github.com/sQVe/tau', pr: 5, directory: '/x' },
      result({
        details: {
          passed: true,
          taskId: 't',
          labels: { 'tau.assignment': '/a', 'tau.profile': 'worker', other: 'x' },
          extra: 1,
        },
      }),
    ),
    kept: [
      call(
        'pr',
        { action: 'verify', repository: 'github.com/sQVe/tau', pr: 5 },
        result({
          details: {
            passed: true,
            taskId: 't',
            labels: { 'tau.assignment': '/a', 'tau.profile': 'worker' },
          },
        }),
      ),
    ],
  },
  {
    rule: 'keeps a pr_feedback call',
    call: call(
      'pr_feedback',
      { action: 'read', pr: 5, repository: 'r', head: 'x' },
      result({ details: {} }),
    ),
    kept: [
      call('pr_feedback', { action: 'read', pr: 5, repository: 'r' }, result({ details: {} })),
    ],
  },
  {
    rule: 'keeps a code_review call with only the target kind',
    call: call(
      'code_review',
      { action: 'capture', target: { kind: 'workingTree', base: 'x' }, directory: '/x' },
      result({ details: { hash: 'h' } }),
    ),
    kept: [
      call(
        'code_review',
        { action: 'capture', target: { kind: 'workingTree' } },
        result({ details: {} }),
      ),
    ],
  },
  {
    rule: 'keeps a full_check call',
    call: call('full_check', {}, result({ details: { passed: false, exitCode: 1 } })),
    kept: [call('full_check', {}, result({ details: { passed: false } }))],
  },
  {
    rule: 'keeps a subagent call with its profile and labels',
    call: call(
      'subagent',
      { profile: 'worker', cwd: '/x', task: 'do' },
      result({
        details: {
          taskId: 't',
          labels: { 'tau.profile': 'worker', 'tau.assignment': '/a', x: 'y' },
          state: 'running',
        },
      }),
    ),
    kept: [
      call(
        'subagent',
        { profile: 'worker' },
        result({
          details: {
            taskId: 't',
            labels: { 'tau.profile': 'worker', 'tau.assignment': '/a' },
          },
        }),
      ),
    ],
  },
  {
    rule: 'keeps another tool that names a pull request',
    call: call('bash', { pr: 1, command: 'x' }, result({ details: { output: 'x' } })),
    kept: [call('bash', { pr: 1 }, result({ details: {} }))],
  },
  {
    rule: 'drops another tool without a positive integer pull request',
    call: call('bash', { pr: 0, command: 'x' }, result({ details: {} })),
    kept: [],
  },
  {
    rule: 'drops another tool with a non-integer pull request',
    call: call('bash', { pr: 1.5 }, result({ details: {} })),
    kept: [],
  },
  {
    rule: 'drops another tool with a string pull request',
    call: call('bash', { pr: '1' }, result({ details: {} })),
    kept: [],
  },
  {
    rule: 'drops another tool without arguments',
    call: call('bash', undefined, result({ details: {} })),
    kept: [],
  },
  {
    rule: 'keeps a codemode call without a result and removes its arguments',
    call: call('codemode', { code: 'x' }, undefined),
    kept: [withoutArguments('codemode')],
  },
  {
    rule: 'drops a codemode call with a result',
    call: call('codemode', { code: 'x' }, result({ details: { calls: [] } })),
    kept: [],
  },
  {
    rule: 'cuts a long error to 200 characters',
    call: call('full_check', {}, result({ error: longError })),
    kept: [call('full_check', {}, result({ error: 'x'.repeat(200) }))],
  },
  {
    rule: 'omits labels that are not an object',
    call: call(
      'subagent',
      { profile: 'worker' },
      result({ details: { labels: 'x', taskId: 't' } }),
    ),
    kept: [call('subagent', { profile: 'worker' }, result({ details: { taskId: 't' } }))],
  },
  {
    rule: 'keeps an empty result',
    call: call('full_check', {}, result({})),
    kept: [call('full_check', {}, result({}))],
  },
];

describe('keepFactCalls', () => {
  it('keeps fact calls and calls naming a pull request', () => {
    for (const row of table) {
      expect(keepFactCalls([row.call]), row.rule).toEqual(row.kept);
    }
  });
});
