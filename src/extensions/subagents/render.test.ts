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

// Raw error text is unbounded; collapsed lines flag it and ctrl+o shows it.
const rawFailure =
  'Error: Command failed: herdr agent start codex --pane w-1 -- --arg\nline two\nagent_not_ready: trust prompt';
const rawObservation = `SyntaxError: Unexpected token 'o', ..."","beta":nope,"gamma"... is not valid JSON at ${records}`;

it('keeps raw failure and observation text off collapsed lines and shows it on ctrl+o', () => {
  const subject = theme();

  for (const state of states) {
    const details = {
      ...statusFixture(state, true),
      failure: rawFailure,
      nativeState: 'unknown',
      observationIssue: rawObservation,
    };
    const collapsed = lines(renderStatusResult(details, false, subject)).join('\n');
    const expanded = lines(renderStatusResult(details, true, subject)).join('\n');

    for (const fragment of ['herdr agent start', 'line two', 'trust prompt', '"beta"', 'nope']) {
      expect(collapsed, `${state} collapsed ${fragment}`).not.toContain(fragment);
    }

    expect(collapsed, `${state} ctrl+o hint`).toContain('ctrl+o');
    expect(expanded, `${state} expanded failure`).toContain('trust prompt');
    expect(expanded, `${state} expanded observation`).toContain('is not valid JSON');
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

// A line may say "stopped" only when a parent cleanup record proves the stop.
const claimsStop = (text: string): boolean => /(?<!not )\bstopped\b/.test(text);

it('claims a stop only for stopped workers and always names the worker', () => {
  const subject = theme();

  for (const state of states) {
    for (const generic of [false, true]) {
      for (const outcome of ['success', 'failure', 'incomplete', undefined]) {
        const output = lines(
          renderStatusResult({ ...statusFixture(state, generic), outcome }, false, subject),
        ).join('\n');
        const label = `${state}/${String(outcome)}/${generic ? 'generic' : 'pi'}`;

        expect(claimsStop(output), `${label} stop claim`).toBe(state === 'stopped');
        expect(output, `${label} name`).toContain('worker-ab');
      }
    }
  }
});

it('shows the question, the report summary, and the pane where the pilot needs them', () => {
  const subject = theme();
  const render = (state: WorkerState) =>
    lines(renderStatusResult(statusFixture(state, false), false, subject)).join('\n');

  expect(render('awaitingReply')).toContain('Which file should I change?');
  expect(render('stopped')).toContain('Finished the loader fix.');
  expect(render('cleanupUnconfirmed')).toContain('pane-1');
  expect(render('notOwned')).toContain('pane-1');
  expect(render('running')).not.toContain('pane-1');
});

it('shows an undelivered or uncertain assignment delivery on the collapsed line', () => {
  const subject = theme();
  const notDelivered = collapsedStatusLines(
    { ...statusFixture('running', true), delivery: 'notDelivered' },
    subject,
  ).join('\n');
  const uncertain = collapsedStatusLines(
    { ...statusFixture('running', true), delivery: 'uncertain' },
    subject,
  ).join('\n');

  expect(notDelivered).toContain('not delivered');
  expect(uncertain).toContain('uncertain');
});

it('shows a blocked or unknown native state for every live state', () => {
  const subject = theme();
  const live: WorkerState[] = ['starting', 'running', 'awaitingReply', 'reported', 'stopping'];

  for (const state of live) {
    const blocked = collapsedStatusLines(
      { ...statusFixture(state, true), nativeState: 'blocked' },
      subject,
    ).join('\n');
    expect(blocked, `${state} blocked`).toContain('blocked');

    const unknown = collapsedStatusLines(
      {
        ...statusFixture(state, true),
        failure: undefined,
        nativeState: 'unknown',
        observationIssue: 'herdr observation failed.',
      },
      subject,
    ).join('\n');
    expect(unknown, `${state} unknown`).toContain('unknown');
    expect(unknown, `${state} ctrl+o hint`).toContain('ctrl+o');
    expect(unknown, `${state} raw reason`).not.toContain('herdr observation failed.');

    const both = collapsedStatusLines(
      { ...statusFixture(state, true), nativeState: 'unknown', observationIssue: 'observed.' },
      subject,
    ).join('\n');
    expect(both.split('ctrl+o').length - 1, `${state} one hint`).toBe(1);
  }
});

it('marks the deadline as enforced only for owned live states', () => {
  const subject = theme();

  for (const state of states) {
    const output = expandedStatusLines(statusFixture(state, false), subject)
      .map(stripVTControlCharacters)
      .join('\n');
    const live = ['starting', 'running', 'awaitingReply', 'reported', 'stopping'].includes(state);

    expect(/\bnot enforced\b/.test(output), `${state} enforcement`).toBe(!live);
  }
});

it('shows the worker name on a reply line and falls back to the short ID', () => {
  const subject = theme();
  const named = lines(renderReplyResult(replyFixture('sent'), false, subject)).join('\n');
  expect(named).toContain('worker-ab');

  const unnamed = lines(
    renderReplyResult({ ...replyFixture('sent'), name: undefined }, false, subject),
  ).join('\n');
  expect(unnamed).toContain(taskId.slice(0, 8));
  expect(unnamed).not.toContain(taskId);
});

it('shows the predecessor name on a follow-up line and falls back to the short ID', () => {
  const subject = theme();
  const named = lines(renderStatusResult(statusFixture('starting', false), false, subject)).join(
    '\n',
  );
  expect(named).toContain('worker-up');

  const unnamed = lines(
    renderStatusResult(
      { ...statusFixture('starting', false), predecessorName: undefined },
      false,
      subject,
    ),
  ).join('\n');
  expect(unnamed).not.toContain('worker-up');
  expect(unnamed).toContain('predeces');
});

it('never claims an acknowledgement and renders each delivery value differently', () => {
  const subject = theme();
  const deliveries = ['sent', 'uncertain', 'notResent', 'notDelivered'];
  const outputs = deliveries.map((delivery) =>
    collapsedReplyLines(replyFixture(delivery), subject).join('\n'),
  );
  const acknowledged = collapsedReplyLines(replyFixture('sent', true), subject).join('\n');

  expect(new Set(outputs).size).toBe(deliveries.length);

  for (const output of [...outputs, acknowledged]) {
    expect(/(?<!not )\backnowledged\b/.test(output)).toBe(false);
  }
});

it('renders at most five history rows and an expansion hint', () => {
  const subject = theme();
  const collapsed = collapsedHistoryLines(historyFixture(8), subject);
  expect(collapsed).toHaveLength(1 + 5 + 1);
  expect(collapsed.join('\n')).toMatch(/\b3\b/);
  expect(collapsed.join('\n')).toMatch(/\b8\b/);

  const small = collapsedHistoryLines(historyFixture(2), subject);
  expect(small).toHaveLength(1 + 2);
  expect(small.join('\n')).not.toContain('ctrl+o');
});

it('distinguishes unloaded history pages from rows hidden by collapse', () => {
  const subject = theme();

  for (const loaded of [5, 8]) {
    const details = { ...historyFixture(loaded), totalMatches: 12, nextOffset: loaded };
    const collapsed = collapsedHistoryLines(details, subject);
    const expansionHints = collapsed.filter((line) => line.includes('ctrl+o'));
    const expanded = expandedHistoryLines(details, subject).join('\n');
    const expectedHint = loaded > 5 ? /\b3\b/ : /^$/;

    expect(collapsed.join('\n')).toMatch(/next page/i);
    expect(expansionHints.join('\n')).toMatch(expectedHint);
    expect(expanded).toContain(`nextOffset: ${loaded}`);
  }

  const lastPage = { ...historyFixture(2), totalMatches: 12 };
  const collapsed = collapsedHistoryLines(lastPage, subject).join('\n');
  const expanded = expandedHistoryLines(lastPage, subject).join('\n');

  expect(collapsed).not.toContain('ctrl+o');
  expect(collapsed).not.toMatch(/next page/i);
  expect(expanded).not.toContain('nextOffset');
});

it('renders every history candidate in the expanded view', () => {
  const subject = theme();
  const expanded = expandedHistoryLines(historyFixture(3), subject).join('\n');
  expect(expanded).toContain('task-abcdef0123456780');
  expect(expanded).toContain('worker-a0');
  expect(expanded).toContain('Fix loader part 0');
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
  expect(() => renderHistoryResult({ outcome: 'list' }, false, subject)).toThrow(
    DefaultRenderingRequiredError,
  );
});

it('falls back to Pi rendering for a legacy prose reply delivery', () => {
  const subject = theme();
  const legacy = {
    ...replyFixture('sent'),
    delivery: 'Herdr accepted the reply text; saved on disk.',
  };

  expect(() => renderReplyResult(legacy, false, subject)).toThrow(DefaultRenderingRequiredError);
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

it('keeps a sibling of the home directory unshortened', () => {
  const subject = theme();
  const sibling = `${homedir()}-other/records`;
  const output = expandedStatusLines(
    { ...statusFixture('stopped', false), directory: sibling },
    subject,
  ).join('\n');

  expect(output).toContain(sibling);
});

it('offers follow-up only to Pi workers', () => {
  const subject = theme();
  const done = { successorTaskId: undefined };
  const pi = expandedStatusLines({ ...statusFixture('stopped', false), ...done }, subject).join(
    '\n',
  );
  const generic = expandedStatusLines({ ...statusFixture('stopped', true), ...done }, subject).join(
    '\n',
  );

  expect(pi).toMatch(/Follow-up available/);
  expect(generic).not.toMatch(/Follow-up available/);
});

it('shows requested native output and receipts on ctrl+o', () => {
  const subject = theme();
  const details = {
    ...statusFixture('running', true),
    nativeOutput: { text: 'Approve the edit? [y/n]' },
    submissionReceipt: {
      intent: { id: 'reply-7' },
      observation: { state: 'not-delivered', detail: 'agent_blocked' },
    },
    questionReceipt: {
      question: { questionId: 'question-9' },
      reply: { replyId: 'r' },
      acknowledgement: undefined,
    },
  };
  const output = lines(renderStatusResult(details, true, subject)).join('\n');

  expect(output).toContain('Approve the edit? [y/n]');
  expect(output).toContain('reply-7');
  expect(output).toContain('not-delivered');
  expect(output).toContain('question-9');
});

it('warns about a child whose cleanup is unconfirmed even when the parent stopped', () => {
  const subject = theme();
  const details = {
    ...statusFixture('stopped', false),
    unconfirmedChildren: [{ taskId: 'child-abcdef0123', directory: records }],
  };
  const collapsed = lines(renderStatusResult(details, false, subject)).join('\n');
  const expanded = lines(renderStatusResult(details, true, subject)).join('\n');

  expect(collapsed).toContain('child-ab');
  expect(collapsed).not.toContain('child-abcdef0123');
  expect(expanded).toContain('child-abcdef0123');
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
