import { expect, it } from 'vitest';

import {
  dialogResponse,
  localPackageSources,
  nextSessionState,
  openWorkers,
  piArguments,
  projectSettings,
  sessionExit,
  sessionOptions,
  startState,
} from './piSessionRules.ts';
import type { SessionEnd } from './piSessionRules.ts';

const launch = (assignmentId: string, address: string, isError = false) => ({
  type: 'tool_execution_end',
  toolName: 'subagent',
  isError,
  result: {
    details: {
      address,
      labels: { 'tau.assignment': `/agent/tau/repo/assignments/${assignmentId}/assignment.json` },
    },
  },
});

const workerMessage = (customType: string, assignmentId: string) => ({
  type: 'message_start',
  message: { role: 'custom', customType, details: { assignmentId } },
});

const settled = { type: 'agent_settled' };
const report = (assignmentId: string) => workerMessage('tau-worker-report', assignmentId);
const ended = (assignmentId: string) => workerMessage('tau-worker-ended', assignmentId);

const stateAfter = (records: unknown[]) => records.reduce(nextSessionState, startState);

it.each([
  { name: 'no record', records: [], step: 'running', open: [] },
  { name: 'settled without a worker', records: [settled], step: 'ended', open: [] },
  {
    name: 'settled with an open worker',
    records: [launch('a', 't1'), settled],
    step: 'running',
    open: ['t1'],
  },
  {
    name: 'report without a later settled',
    records: [launch('a', 't1'), settled, report('a')],
    step: 'running',
    open: [],
  },
  {
    name: 'settled after the report',
    records: [launch('a', 't1'), settled, report('a'), settled],
    step: 'ended',
    open: [],
  },
  {
    name: 'settled after the worker ended without a report',
    records: [launch('a', 't1'), settled, ended('a'), settled],
    step: 'ended',
    open: [],
  },
  {
    name: 'one of two workers reported',
    records: [launch('a', 't1'), launch('b', 't2'), report('a'), settled],
    step: 'running',
    open: ['t2'],
  },
  {
    name: 'both workers closed',
    records: [launch('a', 't1'), launch('b', 't2'), report('a'), ended('b'), settled],
    step: 'ended',
    open: [],
  },
  {
    name: 'report of another assignment',
    records: [launch('a', 't1'), report('b'), settled],
    step: 'running',
    open: ['t1'],
  },
  {
    name: 'failed subagent call',
    records: [launch('a', 't1', true), settled],
    step: 'ended',
    open: [],
  },
  {
    name: 'another tool with the same details',
    records: [{ ...launch('a', 't1'), toolName: 'bash' }, settled],
    step: 'ended',
    open: [],
  },
  {
    name: 'user message with a worker type',
    records: [
      launch('a', 't1'),
      {
        type: 'message_start',
        message: { role: 'user', customType: 'tau-worker-report', details: { assignmentId: 'a' } },
      },
      settled,
    ],
    step: 'running',
    open: ['t1'],
  },
  {
    name: 'another custom message',
    records: [launch('a', 't1'), workerMessage('tau-other', 'a'), settled],
    step: 'running',
    open: ['t1'],
  },
  {
    name: 'accepted prompt',
    records: [{ type: 'response', command: 'prompt', success: true }],
    step: 'running',
    open: [],
  },
  {
    name: 'failed response of another command',
    records: [{ type: 'response', command: 'get_state', success: false }],
    step: 'running',
    open: [],
  },
  {
    name: 'refused prompt',
    records: [{ type: 'response', command: 'prompt', success: false, error: 'no model' }],
    step: 'failed',
    open: [],
  },
  {
    name: 'records after the end',
    records: [settled, launch('a', 't1')],
    step: 'ended',
    open: [],
  },
  { name: 'a record that is no object', records: ['text', settled], step: 'ended', open: [] },
])('end rule: $name', ({ records, step, open }) => {
  const state = stateAfter(records);

  expect(state.step.kind).toBe(step);
  expect(openWorkers(state).map((worker) => worker.address)).toEqual(open);
});

it.each([
  { name: 'with error text', error: 'no model', cause: 'Pi refused the prompt: no model' },
  { name: 'without error text', error: undefined, cause: 'Pi refused the prompt: no error text' },
])('names the cause of a refused prompt $name', ({ error, cause }) => {
  const refused = { type: 'response', command: 'prompt', success: false, error };

  expect(stateAfter([refused]).step).toEqual({ kind: 'failed', cause });
});

it('reads the assignment identifier from the assignment path', () => {
  const state = stateAfter([launch('eace6bd8', 't64p')]);

  expect(openWorkers(state)).toEqual([{ assignmentId: 'eace6bd8', address: 't64p' }]);
});

const worker = { assignmentId: 'a', address: 't64p' };

it.each<{ name: string; end: SessionEnd; code: number; errors: string[] }>([
  { name: 'ended', end: { kind: 'ended' }, code: 0, errors: [] },
  {
    name: 'refused prompt',
    end: { kind: 'failed', cause: 'Pi refused the prompt: no model' },
    code: 1,
    errors: ['FAIL Pi refused the prompt: no model'],
  },
  {
    name: 'early Pi exit',
    end: { kind: 'pi-exit', code: 3 },
    code: 1,
    errors: ['FAIL Pi exited with code 3 before the session ended.'],
  },
  {
    name: 'timeout',
    end: { kind: 'timeout', seconds: 5 },
    code: 1,
    errors: [
      'FAIL The session did not end within 5 seconds.',
      'Worker a still runs at hc address t64p.',
    ],
  },
  {
    name: 'signal',
    end: { kind: 'signal', signal: 'SIGINT' },
    code: 1,
    errors: ['FAIL Stopped by SIGINT.', 'Worker a still runs at hc address t64p.'],
  },
])('exit: $name', ({ end, code, errors }) => {
  expect(sessionExit(end, [worker], '/log/events.jsonl')).toEqual({
    code,
    output: ['Event log: /log/events.jsonl'],
    errors,
  });
});

it.each([
  {
    name: 'prompt text',
    values: { cwd: '/repo', prompt: 'hello' },
    expected: { cwd: '/repo', prompt: { kind: 'text', text: 'hello' }, timeoutSeconds: 1800 },
  },
  {
    name: 'prompt file and timeout',
    values: { cwd: '/repo', 'prompt-file': '/p.txt', timeout: '90' },
    expected: { cwd: '/repo', prompt: { kind: 'file', path: '/p.txt' }, timeoutSeconds: 90 },
  },
  { name: 'no cwd', values: { prompt: 'hello' }, expected: '--cwd is required.' },
  {
    name: 'no prompt',
    values: { cwd: '/repo' },
    expected: 'A prompt is required: give --prompt or --prompt-file.',
  },
  {
    name: 'both prompts',
    values: { cwd: '/repo', prompt: 'hello', 'prompt-file': '/p.txt' },
    expected: 'Give --prompt or --prompt-file, not both.',
  },
  {
    name: 'zero timeout',
    values: { cwd: '/repo', prompt: 'hello', timeout: '0' },
    expected: '--timeout must be a positive integer of seconds, got "0".',
  },
  {
    name: 'fractional timeout',
    values: { cwd: '/repo', prompt: 'hello', timeout: '1.5' },
    expected: '--timeout must be a positive integer of seconds, got "1.5".',
  },
  {
    name: 'timeout with a unit',
    values: { cwd: '/repo', prompt: 'hello', timeout: '10s' },
    expected: '--timeout must be a positive integer of seconds, got "10s".',
  },
  {
    name: 'timeout with a leading sign',
    values: { cwd: '/repo', prompt: 'hello', timeout: '-10' },
    expected: '--timeout must be a positive integer of seconds, got "-10".',
  },
])('options: $name', ({ values, expected }) => {
  expect(sessionOptions(values)).toEqual(expected);
});

it.each([
  {
    name: 'without a model',
    model: undefined,
    expected: ['--mode', 'rpc', '--approve', '--session-dir', '/sessions'],
  },
  {
    name: 'with a model',
    model: 'openai/x',
    expected: ['--mode', 'rpc', '--approve', '--session-dir', '/sessions', '--model', 'openai/x'],
  },
])('Pi arguments: $name', ({ model, expected }) => {
  expect(piArguments('/sessions', model)).toEqual(expected);
});

it.each([
  { name: 'no settings', settings: undefined, expected: [] },
  { name: 'packages that are no list', settings: { packages: 'x' }, expected: [] },
  {
    name: 'paths, objects, and remote packages',
    settings: {
      packages: [
        '/tau/main',
        { source: '../other' },
        'git:github.com/a/b',
        'npm:package',
        'https://github.com/a/b',
        'ssh://git@github.com/a/b',
        'git@github.com:a/b',
        { extensions: [] },
        7,
      ],
    },
    expected: ['/tau/main', '../other'],
  },
])('local package sources: $name', ({ settings, expected }) => {
  expect(localPackageSources(settings)).toEqual(expected);
});

const checkout = { realPath: '/tau/me-1376', name: 'tau' };

const unload = (source: string) => ({
  source,
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
});

it.each([
  { name: 'no user package', userPackages: [], packages: ['/tau/me-1376'] },
  {
    name: 'another checkout of the package',
    userPackages: [{ source: '/link/main', realPath: '/tau/main', name: 'tau' }],
    packages: ['/tau/me-1376', unload('/link/main')],
  },
  {
    name: 'another package and a package without a name',
    userPackages: [
      { source: '/other', realPath: '/other', name: 'other' },
      { source: '/unnamed', realPath: '/unnamed', name: undefined },
    ],
    packages: ['/tau/me-1376'],
  },
])('project settings: $name', ({ userPackages, packages }) => {
  const content = projectSettings(checkout, userPackages) ?? '';

  expect(JSON.parse(content)).toEqual({ packages });
});

it('writes no project settings when the user settings install the checkout', () => {
  const userPackages = [
    { source: '/tau/main', realPath: '/tau/main', name: 'tau' },
    { source: '/link/me-1376', realPath: '/tau/me-1376', name: 'tau' },
  ];

  expect(projectSettings(checkout, userPackages)).toBeUndefined();
});

it.each(['select', 'confirm', 'input', 'editor'])('cancels a %s dialog', (method) => {
  const response = dialogResponse({ type: 'extension_ui_request', id: 'd1', method }) ?? '';

  expect(JSON.parse(response)).toEqual({
    type: 'extension_ui_response',
    id: 'd1',
    cancelled: true,
  });
});

it.each([
  { name: 'a notification', record: { type: 'extension_ui_request', id: 'd1', method: 'notify' } },
  { name: 'another record type', record: { type: 'agent_settled', id: 'd1', method: 'select' } },
  { name: 'a value that is no object', record: 'select' },
])('gives no dialog answer to $name', ({ record }) => {
  expect(dialogResponse(record)).toBeUndefined();
});
