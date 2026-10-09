import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

/** Pi does not export getThemeByName through the public package API. */
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import {
  DefaultRenderingRequiredError,
  collapsedReplyLines,
  collapsedStatusLines,
  expandedStatusLines,
  renderReplyResult,
  renderStatusResult,
} from './render.js';
import subagentsExtension, { registerCapacityRefusal } from './subagents.js';
import type { WorkerState } from './types.js';

const states: WorkerState[] = [
  'starting',
  'running',
  'awaitingReply',
  'reported',
  'stopping',
  'stopped',
  'cleanupUnconfirmed',
  'notOwned',
];

const cleanupStates = new Set<WorkerState>(['cleanupUnconfirmed', 'notOwned']);

const theme = () => {
  initTheme('dark', false);

  const resolved = getThemeByName('dark');

  if (!resolved) {
    throw new Error('Missing dark theme.');
  }

  return resolved;
};

const plain = (component: Component): string =>
  component.render(200).map(stripVTControlCharacters).join('\n');

const lines = (component: Component): string[] =>
  component.render(200).map((line) => stripVTControlCharacters(line).trimEnd());

const taskId = 'task-abcdef0123456789';
const records = join(homedir(), 'records', taskId);

// A full status keeps the fields the renderer must never show collapsed: generated paths, full
// identifiers, and JSON. The summary stays path-free so the collapsed path check is meaningful.
const statusFixture = (state: WorkerState) => ({
  taskId,
  name: 'worker-ab',
  state,
  outcome: state === 'stopped' ? 'success' : 'incomplete',
  deadline: new Date(2023, 10, 14, 14, 13, 20).getTime(),
  predecessorTaskId: 'predecessor-abcdef01',
  predecessorName: 'worker-up',
  successorTaskId: 'successor-abcdef01',
  report: {
    taskId,
    outcome: 'success',
    summary: 'Finished the loader fix.',
    evidence: ['Ran the focused test.', 'Checked the diff.'],
  },
  pendingQuestion: {
    version: 1,
    taskId,
    questionId: 'question-abcdef01',
    question: 'Which file should I change?',
  },
  failure: 'Startup failed.',
  cleanup: 'Sent the terminal stop and confirmed the pane closed.',
  recovery: {
    paneId: 'pane-1',
    directory: records,
    nativeSessionFile: join(records, 'session.jsonl'),
  },
  directory: records,
  nativeSessionId: 'native-abcdef01',
  nativeSessionFile: join(records, 'session.jsonl'),
});

const replyFixture = (workerAcknowledged?: boolean) => ({
  taskId,
  name: 'worker-ab',
  questionId: 'question-abcdef01',
  replyAccepted: true,
  ...(workerAcknowledged === undefined ? {} : { workerAcknowledged }),
});

const renderers = () => {
  const fake = fakeExtensionApi();
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  return { tools: fake.tools, messageRenderers: fake.messageRenderers };
};

const options: ToolRenderResultOptions = { expanded: false, isPartial: false };
const context = {} as Parameters<NonNullable<ToolDefinition['renderResult']>>[3];

it.each(states)('renders a Pi %s status collapsed and expanded', (state) => {
  const subject = theme();
  const details = statusFixture(state);

  for (const expanded of [false, true]) {
    const output = plain(renderStatusResult(details, expanded, subject));
    expect(output.trim().length, `${state} rendered nothing`).toBeGreaterThan(0);
    expect(output).not.toContain('{');
  }
});

it('keeps generated paths, JSON, and full task IDs out of collapsed status lines', () => {
  const subject = theme();

  for (const state of states) {
    if (cleanupStates.has(state)) {
      continue;
    }

    const output = collapsedStatusLines(statusFixture(state), subject).join('\n');
    expect(output, `${state} leaked braces`).not.toContain('{');
    expect(output, `${state} leaked a path`).not.toMatch(/(^|\s)\/\S|~\//);
    expect(output, `${state} leaked the full task ID`).not.toContain(taskId);
    expect(output, `${state} leaked a home path`).not.toContain(homedir());
  }
});

// Raw error text is unbounded; collapsed lines flag it and ctrl+o shows it.
const rawFailure =
  'Error: Command failed: herdr agent start codex --pane w-1 -- --arg\nline two\nagent_not_ready: trust prompt';

it('keeps raw failure text off collapsed lines and shows it on ctrl+o', () => {
  const subject = theme();

  for (const state of states) {
    const details = { ...statusFixture(state), failure: rawFailure };

    const collapsed = lines(renderStatusResult(details, false, subject)).join('\n');
    const expanded = lines(renderStatusResult(details, true, subject)).join('\n');

    for (const fragment of ['herdr agent start', 'line two', 'trust prompt']) {
      expect(collapsed, `${state} collapsed ${fragment}`).not.toContain(fragment);
    }

    expect(collapsed, `${state} ctrl+o hint`).toContain('ctrl+o');
    expect(expanded, `${state} expanded failure`).toContain('trust prompt');
  }
});

it('uses the check mark only for a stopped success and shows the deadline only for live states', () => {
  const subject = theme();

  for (const state of states) {
    for (const outcome of ['success', 'failure', 'incomplete']) {
      const output = collapsedStatusLines({ ...statusFixture(state), outcome }, subject).join('\n');
      const check = state === 'stopped' && outcome === 'success';
      expect(output.includes('✓'), `${state}/${outcome} check mark`).toBe(check);
      const deadline = ['starting', 'running', 'awaitingReply'].includes(state);
      expect(/\d{2}:\d{2}/.test(output), `${state}/${outcome} deadline`).toBe(deadline);
    }
  }
});

// A line may say "stopped" only when a parent cleanup record proves the stop.
const claimsStop = (text: string): boolean => /(?<!not )\bstopped\b/.test(text);

it('claims a stop only for stopped workers and always names the worker', () => {
  const subject = theme();

  for (const state of states) {
    for (const outcome of ['success', 'failure', 'incomplete', undefined]) {
      const output = lines(
        renderStatusResult({ ...statusFixture(state), outcome }, false, subject),
      ).join('\n');

      const label = `${state}/${String(outcome)}`;

      expect(claimsStop(output), `${label} stop claim`).toBe(state === 'stopped');
      expect(output, `${label} name`).toContain('worker-ab');
    }
  }
});

it('shows the question, the report summary, and the pane where the pilot needs them', () => {
  const subject = theme();

  const render = (state: WorkerState) =>
    lines(renderStatusResult(statusFixture(state), false, subject)).join('\n');

  expect(render('awaitingReply')).toContain('Which file should I change?');
  expect(render('stopped')).toContain('Finished the loader fix.');
  expect(render('cleanupUnconfirmed')).toContain('pane-1');
  expect(render('notOwned')).toContain('pane-1');
  expect(render('running')).not.toContain('pane-1');
});

it('marks the deadline as enforced only for owned live states', () => {
  const subject = theme();

  for (const state of states) {
    const output = expandedStatusLines(statusFixture(state), subject)
      .map(stripVTControlCharacters)
      .join('\n');

    const live = ['starting', 'running', 'awaitingReply', 'reported', 'stopping'].includes(state);

    expect(/\bnot enforced\b/.test(output), `${state} enforcement`).toBe(!live);
  }
});

it('shows the worker name on a reply line and falls back to the short ID', () => {
  const subject = theme();
  const named = lines(renderReplyResult(replyFixture(), false, subject)).join('\n');
  expect(named).toContain('worker-ab');

  const unnamed = lines(
    renderReplyResult({ ...replyFixture(), name: undefined }, false, subject),
  ).join('\n');

  expect(unnamed).toContain(taskId.slice(0, 8));
  expect(unnamed).not.toContain(taskId);
});

it('shows the predecessor name on a follow-up line and falls back to the short ID', () => {
  const subject = theme();

  const named = lines(renderStatusResult(statusFixture('starting'), false, subject)).join('\n');

  expect(named).toContain('worker-up');

  const unnamed = lines(
    renderStatusResult(
      { ...statusFixture('starting'), predecessorName: undefined },
      false,
      subject,
    ),
  ).join('\n');

  expect(unnamed).not.toContain('worker-up');
  expect(unnamed).toContain('predeces');
});

it('claims an acknowledgement only when the worker saved one', () => {
  const subject = theme();
  const pending = collapsedReplyLines(replyFixture(false), subject).join('\n');
  const acknowledged = collapsedReplyLines(replyFixture(true), subject).join('\n');

  expect(/(?<!not )\backnowledged\b/.test(pending)).toBe(false);
  expect(/(?<!not )\backnowledged\b/.test(acknowledged)).toBe(true);
});

it('renders the evidence notice line with the pane ID', () => {
  const subject = theme();

  const details = {
    taskId,
    name: 'worker-ab',
    evidenceError: 'Invalid worker lifecycle record.',
    recovery: { paneId: 'pane-7', directory: records },
  };

  const collapsed = plain(renderStatusResult(details, false, subject));
  expect(collapsed).toContain('pane-7');
  expect(claimsStop(collapsed)).toBe(false);
  expect(collapsed).not.toContain('{');

  const expanded = plain(renderStatusResult(details, true, subject));
  expect(expanded).toContain('Invalid worker lifecycle record.');
});

it('rejects results without a worker state so Pi renders its default', () => {
  const subject = theme();

  expect(() => renderStatusResult({ taskId }, false, subject)).toThrow(
    DefaultRenderingRequiredError,
  );

  expect(() => renderReplyResult({ taskId }, false, subject)).toThrow(
    DefaultRenderingRequiredError,
  );
});

it('renders through the registered tool definitions and the message renderer', () => {
  const subject = theme();
  const { tools, messageRenderers } = renderers();
  const status = tools.get('subagent_status');
  const reply = tools.get('subagent_reply');

  if (!status?.renderResult || !reply?.renderResult) {
    throw new Error('Missing renderers.');
  }

  const statusOutput = plain(
    status.renderResult(
      { content: [{ type: 'text', text: '{}' }], details: statusFixture('running') },
      options,
      subject,
      context,
    ),
  );

  expect(statusOutput).toContain('running');

  const replyOutput = plain(
    reply.renderResult(
      { content: [{ type: 'text', text: '{}' }], details: replyFixture() },
      options,
      subject,
      context,
    ),
  );

  expect(replyOutput).toContain('reply saved');

  const renderer = messageRenderers.get('tau-worker');
  expect(renderer, 'tau-worker renderer must be registered').toBeTypeOf('function');

  const notice = renderer?.(
    {
      role: 'custom',
      customType: 'tau-worker',
      content: '{}',
      display: true,
      details: statusFixture('awaitingReply'),
      timestamp: 0,
    },
    { expanded: false, outputPad: 0 },
    subject,
  );

  expect(notice, 'notice must render').toBeDefined();
  expect(plain(notice as Component)).toContain('asks');
});

it('keeps generated paths, JSON, and full task IDs out of collapsed reply lines', () => {
  const subject = theme();
  const reply = collapsedReplyLines(replyFixture(), subject).join('\n');
  expect(reply).not.toContain('{');
  expect(reply).not.toMatch(/(^|\s)\/\S|~\//);
  expect(reply).not.toContain(taskId);
});

it('wires a call and a result renderer into every subagent tool', () => {
  const subject = theme();
  const { tools } = renderers();

  for (const name of [
    'subagent',
    'subagent_follow_up',
    'subagent_status',
    'subagent_reply',
    'subagent_cancel',
  ]) {
    expect(tools.get(name)?.renderCall, `${name} call renderer`).toBeTypeOf('function');
    expect(tools.get(name)?.renderResult, `${name} result renderer`).toBeTypeOf('function');
  }

  const launch = tools.get('subagent');

  const call = launch?.renderCall?.(
    {
      task: 'Do the thing.\nSecond line.',
      profile: 'worker',
      timeoutSeconds: 60,
    },
    subject,
    context,
  );

  const text = plain(call as Component);
  expect(text).toContain('Launch worker');
  expect(text).toContain('worker');
  expect(text).toContain('Do the thing.');
  expect(text).not.toContain('Second line.');
});

it('uses Pi default rendering for a state-less result through the tool component', () => {
  initTheme('dark', false);
  const { tools } = renderers();
  const status = tools.get('subagent_status');

  if (!status) {
    throw new Error('Missing status tool.');
  }

  const content = '{"taskId":"legacy-task"}';

  const component = new ToolExecutionComponent(
    'subagent_status',
    'call',
    { taskId: 'legacy-task' },
    {},
    status,
    { requestRender: vi.fn<TUI['requestRender']>() } as unknown as TUI,
    '/repo',
  );

  component.updateResult({
    content: [{ type: 'text', text: content }],
    details: { taskId: 'legacy-task' },
    isError: false,
  });

  expect(plain(component)).toContain(content);
});

it('shortens the home directory in the expanded records and session rows', () => {
  const subject = theme();
  const output = expandedStatusLines(statusFixture('stopped'), subject).join('\n');
  expect(output).toContain(`~/records/${taskId}`);
});

it('keeps a sibling of the home directory unshortened', () => {
  const subject = theme();
  const sibling = `${homedir()}-other/records`;

  const output = expandedStatusLines(
    { ...statusFixture('stopped'), directory: sibling },
    subject,
  ).join('\n');

  expect(output).toContain(sibling);
});

it('offers follow-up only to a reported worker without a successor', () => {
  const subject = theme();
  const done = { successorTaskId: undefined };
  const available = expandedStatusLines({ ...statusFixture('stopped'), ...done }, subject);
  const followedUp = expandedStatusLines(statusFixture('stopped'), subject).join('\n');

  expect(available.join('\n')).toMatch(/Follow-up available/);
  expect(followedUp).not.toMatch(/Follow-up available/);
  expect(followedUp).toContain('successor-abcdef01');
});

it('shows which handover sections the saved report is missing', () => {
  const subject = theme();

  const legacy = stripVTControlCharacters(
    expandedStatusLines(statusFixture('stopped'), subject).join('\n'),
  );

  expect(legacy).toContain('Handover sections missing: Changes, Evidence, Decisions, Concerns');

  const completeReport = {
    ...statusFixture('stopped'),
    report: {
      outcome: 'success',
      summary: 'Changes: fixed loader\nEvidence: tests passed\nDecisions: none\nConcerns: none',
      evidence: [],
    },
  };

  const complete = stripVTControlCharacters(
    expandedStatusLines(completeReport, subject).join('\n'),
  );

  expect(complete).not.toContain('Handover sections missing');
});

it('shows a requested question receipt on ctrl+o', () => {
  const subject = theme();

  const details = {
    ...statusFixture('running'),
    questionReceipt: {
      question: { questionId: 'question-9' },
      reply: { replyId: 'r' },
      acknowledgement: undefined,
    },
  };

  const output = lines(renderStatusResult(details, true, subject)).join('\n');

  expect(output).toContain('question-9');
});

it('renders call lines while streaming arguments are still incomplete', () => {
  const subject = theme();
  const { tools } = renderers();
  const launch = tools.get('subagent');
  const followUp = tools.get('subagent_follow_up');

  expect(() => launch?.renderCall?.({ profile: 'worker' }, subject, context)).not.toThrow();
  expect(() => launch?.renderCall?.({}, subject, context)).not.toThrow();
  expect(() => followUp?.renderCall?.({}, subject, context)).not.toThrow();

  const text = plain(launch?.renderCall?.({ profile: 'worker' }, subject, context) as Component);
  expect(text).toContain('worker');
});

it('shows only a short task ID on task call lines', () => {
  const subject = theme();
  const { tools } = renderers();

  const calls: [string, Record<string, unknown>][] = [
    ['subagent_status', { taskId }],
    ['subagent_reply', { taskId, replyId: 'reply', reply: 'Scoped text.' }],
    ['subagent_cancel', { taskId }],
    ['subagent_follow_up', { sourceTaskId: taskId, task: 'Continue.', timeoutSeconds: 60 }],
  ];

  for (const [name, parameters] of calls) {
    const text = plain(tools.get(name)?.renderCall?.(parameters, subject, context) as Component);
    expect(text, `${name} call line`).toContain(taskId.slice(0, 8));
    expect(text, `${name} call line`).not.toContain(taskId);
  }
});
