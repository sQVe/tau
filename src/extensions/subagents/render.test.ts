import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type {
  ExtensionAPI,
  MessageRenderer,
  ToolDefinition,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { createEventBus, initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

/** Pi does not export getThemeByName through the public package API. */
import { getThemeByName } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import subagentsExtension from './index.js';
import {
  DefaultRenderingRequiredError,
  collapsedHistoryLines,
  collapsedReplyLines,
  collapsedStatusLines,
  expandedHistoryLines,
  expandedStatusLines,
  renderHistoryResult,
  renderReplyResult,
  renderStatusResult,
} from './render.js';
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
const statusFixture = (state: WorkerState, generic: boolean) => ({
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
  capacityHeld: true,
  directory: records,
  nativeSessionId: 'native-abcdef01',
  nativeSessionFile: join(records, 'session.jsonl'),
  harness: generic ? 'generic' : 'pi',
  ...(generic
    ? { nativeState: 'blocked', nativeSessionId: undefined, nativeSessionFile: undefined }
    : {}),
});

const replyFixture = (delivery: string, workerAcknowledged?: boolean) => ({
  taskId,
  name: 'worker-ab',
  questionId: 'question-abcdef01',
  replyAccepted: true,
  delivery,
  ...(workerAcknowledged === undefined ? {} : { workerAcknowledged }),
});

const candidate = (index: number, state: WorkerState) => ({
  taskId: `task-abcdef012345678${index}`,
  name: `worker-${String.fromCharCode(97 + index)}${index}`,
  description: `Fix loader part ${index}`,
  state,
  nativeEvidence: 'available',
  report: { outcome: 'success', summary: `Part ${index} finished.`, evidence: [] },
});

const historyFixture = (count: number) => ({
  outcome: 'clarification',
  totalMatches: count,
  candidates: Array.from({ length: Math.min(count, 10) }, (_, index) =>
    candidate(index, index % 2 === 0 ? 'stopped' : 'running'),
  ),
});

const renderers = () => {
  const tools = new Map<string, ToolDefinition>();
  const messageRenderers = new Map<string, MessageRenderer>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerMessageRenderer: (customType: string, renderer: MessageRenderer) => {
      messageRenderers.set(customType, renderer);
    },
  } as unknown as ExtensionAPI);

  return { tools, messageRenderers };
};

const options: ToolRenderResultOptions = { expanded: false, isPartial: false };
const context = {} as Parameters<NonNullable<ToolDefinition['renderResult']>>[3];

it.each(states)('renders a Pi %s status collapsed and expanded', (state) => {
  const subject = theme();
  const details = statusFixture(state, false);

  for (const expanded of [false, true]) {
    const output = plain(renderStatusResult(details, expanded, subject));
    expect(output.trim().length, `${state} rendered nothing`).toBeGreaterThan(0);
    expect(output).not.toContain('{');
  }
});

it.each(states)('renders a generic %s status collapsed and expanded', (state) => {
  const subject = theme();
  const details = statusFixture(state, true);

  for (const expanded of [false, true]) {
    const output = plain(renderStatusResult(details, expanded, subject));
    expect(output.trim().length, `${state} rendered nothing`).toBeGreaterThan(0);
  }
});

it('keeps generated paths, JSON, and full task IDs out of collapsed status lines', () => {
  const subject = theme();

  for (const state of states) {
    if (cleanupStates.has(state)) {
      continue;
    }

    for (const generic of [false, true]) {
      const output = collapsedStatusLines(statusFixture(state, generic), subject).join('\n');
      expect(output, `${state} leaked braces`).not.toContain('{');
      expect(output, `${state} leaked a path`).not.toMatch(/(^|\s)\/\S|~\//);
      expect(output, `${state} leaked the full task ID`).not.toContain(taskId);
      expect(output, `${state} leaked a home path`).not.toContain(homedir());
    }
  }
});

it('uses the check mark only for a stopped success and shows the deadline only for live states', () => {
  const subject = theme();

  for (const state of states) {
    for (const generic of [false, true]) {
      for (const outcome of ['success', 'failure', 'incomplete']) {
        const output = collapsedStatusLines(
          { ...statusFixture(state, generic), outcome },
          subject,
        ).join('\n');
        const check = state === 'stopped' && outcome === 'success';
        expect(output.includes('✓'), `${state}/${outcome} check mark`).toBe(check);
        const deadline = ['starting', 'running', 'awaitingReply'].includes(state);
        expect(/\d{2}:\d{2}/.test(output), `${state}/${outcome} deadline`).toBe(deadline);
      }
    }
  }
});

it('never claims a stop or acknowledgement the records do not prove', () => {
  const subject = theme();
  const running = collapsedStatusLines(statusFixture('running', false), subject).join('\n');
  expect(running).toContain('running');
  expect(running).not.toContain('stopped');

  const reported = collapsedStatusLines(statusFixture('reported', false), subject).join('\n');
  expect(reported).toContain('reported incomplete · not stopped yet');

  const cleanup = collapsedStatusLines(statusFixture('cleanupUnconfirmed', false), subject).join(
    '\n',
  );
  expect(cleanup).toContain('cleanup unconfirmed');

  const stopped = collapsedStatusLines(statusFixture('stopped', false), subject).join('\n');
  expect(stopped).toContain('reported success · stopped');
});

const collapsedCases: { state: WorkerState; outcome: string | undefined; lines: string[] }[] = [
  {
    state: 'starting',
    outcome: 'incomplete',
    lines: ['○ worker-ab starting · follows worker-up · deadline 14:13'],
  },
  { state: 'running', outcome: 'incomplete', lines: ['● worker-ab running · deadline 14:13'] },
  {
    state: 'awaitingReply',
    outcome: 'incomplete',
    lines: ['? worker-ab asks · deadline 14:13', '  Which file should I change?'],
  },
  {
    state: 'reported',
    outcome: 'incomplete',
    lines: ['◐ worker-ab reported incomplete · not stopped yet'],
  },
  { state: 'stopping', outcome: 'incomplete', lines: ['◐ worker-ab stopping'] },
  {
    state: 'stopped',
    outcome: 'success',
    lines: ['✓ worker-ab reported success · stopped', '  Finished the loader fix.'],
  },
  {
    state: 'stopped',
    outcome: 'failure',
    lines: ['✗ worker-ab stopped · failure', '  Finished the loader fix.'],
  },
  {
    state: 'stopped',
    outcome: 'incomplete',
    lines: ['◐ worker-ab stopped · incomplete', '  Finished the loader fix.'],
  },
  {
    state: 'stopped',
    outcome: undefined,
    lines: ['◐ worker-ab stopped', '  Finished the loader fix.'],
  },
  {
    state: 'cleanupUnconfirmed',
    outcome: 'incomplete',
    lines: [
      '! worker-ab incomplete · cleanup unconfirmed',
      '  Check pane pane-1 and stop it by hand.',
    ],
  },
  {
    state: 'notOwned',
    outcome: 'incomplete',
    lines: ['◇ worker-ab may still be running · not tracked by this session · pane pane-1'],
  },
];

it.each(collapsedCases)(
  'pins the exact collapsed line for $state ($outcome)',
  ({ state, outcome, lines: expected }) => {
    const subject = theme();
    const rendered = lines(
      renderStatusResult({ ...statusFixture(state, false), outcome }, false, subject),
    );

    expect(rendered).toEqual(expected);
  },
);

it('marks the deadline as enforced only for owned live states', () => {
  const subject = theme();

  for (const state of states) {
    const output = expandedStatusLines(statusFixture(state, false), subject)
      .map(stripVTControlCharacters)
      .join('\n');
    const live = ['starting', 'running', 'awaitingReply', 'reported', 'stopping'].includes(state);

    expect(output).toContain(`Deadline: 14:13 · ${live ? '' : 'not '}enforced by this session`);
  }
});

it('shows the worker name on a reply line and falls back to the short ID', () => {
  const subject = theme();
  const named = lines(renderReplyResult(replyFixture('sent'), false, subject)).join('\n');
  expect(named).toContain('↳ worker-ab reply saved');

  const unnamed = lines(
    renderReplyResult({ ...replyFixture('sent'), name: undefined }, false, subject),
  ).join('\n');
  expect(unnamed).toContain('↳ task-abc reply saved');
});

it('shows the predecessor name on a follow-up line and falls back to the short ID', () => {
  const subject = theme();
  const named = lines(renderStatusResult(statusFixture('starting', false), false, subject)).join(
    '\n',
  );
  expect(named).toContain('follows worker-up');

  const unnamed = lines(
    renderStatusResult(
      { ...statusFixture('starting', false), predecessorName: undefined },
      false,
      subject,
    ),
  ).join('\n');
  expect(unnamed).toContain('follows predeces');
});

it('renders cleanupUnconfirmed with the pane instruction and notOwned with the pane ID', () => {
  const subject = theme();
  const cleanup = collapsedStatusLines(statusFixture('cleanupUnconfirmed', false), subject).join(
    '\n',
  );
  expect(cleanup).toContain('cleanup unconfirmed');
  expect(cleanup).toContain('Check pane pane-1 and stop it by hand.');

  const notOwned = collapsedStatusLines(statusFixture('notOwned', false), subject).join('\n');
  expect(notOwned).toContain('may still be running');
  expect(notOwned).toContain('pane pane-1');
});

it('renders each reply delivery line', () => {
  const subject = theme();
  expect(collapsedReplyLines(replyFixture('sent'), subject).join('\n')).toContain(
    'sent to its pane · not acknowledged yet',
  );
  expect(collapsedReplyLines(replyFixture('sent', true), subject).join('\n')).not.toContain(
    'not acknowledged yet',
  );
  expect(collapsedReplyLines(replyFixture('uncertain'), subject).join('\n')).toContain(
    'delivery uncertain · do not resend',
  );
  expect(collapsedReplyLines(replyFixture('notResent'), subject).join('\n')).toContain(
    'reply already saved · not resent',
  );
  expect(collapsedReplyLines(replyFixture('notDelivered'), subject).join('\n')).toContain(
    'reply not delivered · a native dialog needs you',
  );
});

it('renders at most five history rows and an expansion hint', () => {
  const subject = theme();
  const collapsed = collapsedHistoryLines(historyFixture(8), subject);
  expect(collapsed).toHaveLength(1 + 5 + 1);
  expect(collapsed.join('\n')).toContain('… 3 more (ctrl+o)');
  expect(collapsed.join('\n')).toContain('8 matches');

  const small = collapsedHistoryLines(historyFixture(2), subject);
  expect(small).toHaveLength(1 + 2);
  expect(small.join('\n')).not.toContain('ctrl+o');
});

it('renders every history candidate in the expanded view', () => {
  const subject = theme();
  const expanded = expandedHistoryLines(historyFixture(3), subject).join('\n');
  expect(expanded).toContain('task-abcdef0123456780');
  expect(expanded).toContain('worker-a0');
  expect(expanded).toContain('Fix loader part 0');
  expect(expanded).toContain('Native evidence');
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
  expect(collapsed).toContain('evidence unreadable');
  expect(collapsed).toContain('check pane pane-7');
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
  expect(() => renderHistoryResult({ outcome: 'list' }, false, subject)).toThrow(
    DefaultRenderingRequiredError,
  );
});

it('renders through the registered tool definitions and the message renderer', () => {
  const subject = theme();
  const { tools, messageRenderers } = renderers();
  const status = tools.get('subagent_status');
  const reply = tools.get('subagent_reply');
  const history = tools.get('subagent_history');

  if (!status?.renderResult || !reply?.renderResult || !history?.renderResult) {
    throw new Error('Missing renderers.');
  }

  const statusOutput = plain(
    status.renderResult(
      { content: [{ type: 'text', text: '{}' }], details: statusFixture('running', false) },
      options,
      subject,
      context,
    ),
  );
  expect(statusOutput).toContain('running');

  const replyOutput = plain(
    reply.renderResult(
      { content: [{ type: 'text', text: '{}' }], details: replyFixture('sent') },
      options,
      subject,
      context,
    ),
  );
  expect(replyOutput).toContain('reply saved');

  const historyOutput = plain(
    history.renderResult(
      { content: [{ type: 'text', text: '{}' }], details: historyFixture(3) },
      options,
      subject,
      context,
    ),
  );
  expect(historyOutput).toContain('3 matches');

  const renderer = messageRenderers.get('tau-worker');
  expect(renderer, 'tau-worker renderer must be registered').toBeTypeOf('function');
  const notice = renderer?.(
    {
      role: 'custom',
      customType: 'tau-worker',
      content: '{}',
      display: true,
      details: statusFixture('awaitingReply', false),
      timestamp: 0,
    },
    { expanded: false, outputPad: 0 },
    subject,
  );
  expect(notice, 'notice must render').toBeDefined();
  expect(plain(notice as Component)).toContain('asks');
});

it('renders the tau-worker-child notice with the same details', () => {
  const subject = theme();
  const { messageRenderers } = renderers();
  const renderer = messageRenderers.get('tau-worker-child');
  expect(renderer, 'tau-worker-child renderer must be registered').toBeTypeOf('function');
  const notice = renderer?.(
    {
      role: 'custom',
      customType: 'tau-worker-child',
      content: '{}',
      display: true,
      details: statusFixture('stopped', false),
      timestamp: 0,
    },
    { expanded: false, outputPad: 0 },
    subject,
  );

  expect(plain(notice as Component)).toContain('reported success · stopped');
});

it('keeps generated paths, JSON, and full task IDs out of collapsed reply and history lines', () => {
  const subject = theme();
  const reply = collapsedReplyLines(replyFixture('sent'), subject).join('\n');
  expect(reply).not.toContain('{');
  expect(reply).not.toMatch(/(^|\s)\/\S|~\//);
  expect(reply).not.toContain(taskId);

  for (const total of [1, 8]) {
    const history = collapsedHistoryLines(historyFixture(total), subject).join('\n');
    expect(history, `${total} history lines`).not.toContain('{');
    expect(history, `${total} history paths`).not.toMatch(/(^|\s)\/\S|~\//);
    expect(history, `${total} history full IDs`).not.toContain(taskId);
  }
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
    'subagent_history',
  ]) {
    expect(tools.get(name)?.renderCall, `${name} call renderer`).toBeTypeOf('function');
    expect(tools.get(name)?.renderResult, `${name} result renderer`).toBeTypeOf('function');
  }

  const launch = tools.get('subagent');
  const call = launch?.renderCall?.(
    {
      task: 'Do the thing.\nSecond line.',
      profile: 'worker',
      permissions: 'trusted-full-tools',
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
  const output = expandedStatusLines(statusFixture('stopped', false), subject).join('\n');
  expect(output).toContain(`~/records/${taskId}`);
});

it('shows only a short task ID on task call lines', () => {
  const subject = theme();
  const { tools } = renderers();
  const calls: [string, Record<string, unknown>][] = [
    ['subagent_status', { taskId }],
    ['subagent_reply', { taskId, replyId: 'reply', reply: 'Scoped text.', scopeUnchanged: true }],
    ['subagent_cancel', { taskId }],
    [
      'subagent_follow_up',
      { sourceTaskId: taskId, task: 'Continue.', timeoutSeconds: 60, settingsUnchanged: true },
    ],
  ];

  for (const [name, parameters] of calls) {
    const text = plain(tools.get(name)?.renderCall?.(parameters, subject, context) as Component);
    expect(text, `${name} call line`).toContain(taskId.slice(0, 8));
    expect(text, `${name} call line`).not.toContain(taskId);
  }
});
