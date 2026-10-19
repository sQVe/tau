import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Theme } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import {
  callText,
  DefaultRenderingRequiredError,
  firstLine,
  renderNotice,
  renderReplyResult,
  renderStatusResult,
  shortId,
} from './render.js';

const home = vi.hoisted(() => ({ override: undefined as string | undefined }));

vi.mock(import('node:os'), async (importOriginal) => {
  const original = await importOriginal();

  return { ...original, homedir: () => home.override ?? original.homedir() };
});

// Keeps the visible text exact: styling adds no characters.
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const theme = plainTheme as unknown as Theme;

const collapsed = (details: unknown): string[] =>
  renderStatusResult(details, false, theme)
    .render(200)
    .map((line) => line.trimEnd());

const expanded = (details: unknown): string[] =>
  renderStatusResult(details, true, theme)
    .render(200)
    .map((line) => line.trimEnd());

const deadlineAt = new Date(2023, 0, 2, 3, 5).getTime();

const lineWith = (lines: string[], label: string): string | undefined =>
  lines.find((line) => line.startsWith(label));

it('renders a bare running worker without absent fields in both modes', () => {
  expect(collapsed({ state: 'running' })).toHaveLength(1);
  expect(collapsed({ state: 'running' }).join('\n')).not.toContain('undefined');

  const lines = expanded({ state: 'running' });

  expect(lines).toHaveLength(4);
  expect(lines.join('\n')).not.toContain('undefined');
  expect(lines.every((line) => /^[A-Za-z -]+: \S/u.test(line))).toBe(true);
});

it('renders a bare awaiting-reply worker without a question', () => {
  expect(collapsed({ state: 'awaitingReply' })).toHaveLength(1);
  expect(collapsed({ state: 'awaitingReply' })[0]).not.toBe(collapsed({ state: 'running' })[0]);

  const asking = collapsed({
    state: 'awaitingReply',
    pendingQuestion: { questionId: 'q-1', question: 'Which file?' },
  });

  expect(collapsed({ state: 'awaitingReply' })[0]).not.toBe(asking[0]);
});

it('offers a follow-up only for a stopped worker with a saved report', () => {
  const followUp = (details: unknown) => lineWith(expanded(details), 'Follow-up:') ?? '';
  const report = { outcome: 'success', summary: 'Done.' };

  expect(collapsed({ state: 'stopped' })).toHaveLength(1);

  expect(followUp({ state: 'stopped', taskId: 'task-1', report })).toContain('task-1');
  expect(followUp({ state: 'stopped', taskId: 'task-1' })).not.toContain('task-1');
  expect(followUp({ state: 'stopped', taskId: 'task-1' })).toMatch(/^Follow-up: \S/u);
  expect(followUp({ state: 'stopped', taskId: 'task-1', report: null })).not.toContain('task-1');
  expect(followUp({ state: 'running', taskId: 'task-1', report })).not.toContain('task-1');

  expect(followUp({ state: 'stopped', taskId: 'task-1' })).toBe(
    followUp({ state: 'stopped', taskId: 'task-1', report: null }),
  );

  expect(
    followUp({ state: 'stopped', taskId: 'task-1', report, successorTaskId: 'successor-1' }),
  ).toContain('successor-1');
});

it('keeps a missing source task ID out of the follow-up line', () => {
  const line = lineWith(
    expanded({ state: 'stopped', report: { outcome: 'success', summary: 'Done.' } }),
    'Follow-up:',
  );

  expect(line).toBeDefined();
  expect(line).not.toContain('undefined');
});

it('names the pane to check only when the pane ID is saved', () => {
  const second = (details: unknown) => collapsed(details)[1];

  const bare = collapsed({ state: 'cleanupUnconfirmed' });

  expect(bare).toHaveLength(2);
  expect(bare.join('\n')).not.toContain('undefined');
  expect(collapsed({ state: 'cleanupUnconfirmed', recovery: { paneId: '' } })).toEqual(bare);

  expect(second({ state: 'cleanupUnconfirmed', recovery: { paneId: 'pane-9' } })).toContain(
    'pane-9',
  );

  const untracked = collapsed({ state: 'notOwned' });

  expect(untracked).toHaveLength(1);
  expect(untracked[0]).toMatch(/· \S/u);
  expect(untracked.join('\n')).not.toContain('undefined');
  expect(collapsed({ state: 'notOwned', recovery: { paneId: '' } })).toEqual(untracked);
  expect(collapsed({ state: 'notOwned', recovery: { paneId: 'pane-9' } })[0]).toContain('pane-9');
});

it('shows the outcome from the details, then the report, then a placeholder for a reported worker', () => {
  const marked = collapsed({ state: 'reported', outcome: 'marker' })[0] ?? '';
  const [before = '', after = ''] = marked.split('marker');

  const fromDetails = collapsed({
    state: 'reported',
    outcome: 'marker',
    report: { outcome: 'other' },
  })[0];

  expect(fromDetails).toBe(marked);
  expect(collapsed({ state: 'reported', report: { outcome: 'marker' } })[0]).toBe(marked);

  const unknown = collapsed({ state: 'reported' })[0] ?? '';
  const placeholder = unknown.slice(before.length, unknown.length - after.length);

  expect(unknown.startsWith(before)).toBe(true);
  expect(unknown.endsWith(after)).toBe(true);
  expect(placeholder.trim()).not.toBe('');
  expect(unknown).not.toContain('undefined');

  const settled = collapsed({ state: 'cleanupUnconfirmed', outcome: 'marker' })[0] ?? '';

  expect(settled).toContain('marker');
  expect(settled).not.toBe(marked);
});

it('says a reported worker is not stopped yet only while it is reported', () => {
  const marked = collapsed({ state: 'reported', outcome: 'marker' })[0] ?? '';
  const notice = marked.split('marker')[1]?.replace(/^[\s·]+/u, '') ?? '';

  expect(notice).not.toBe('');

  for (const state of ['running', 'stopping', 'stopped']) {
    expect(collapsed({ state })[0]).not.toContain(notice);
  }
});

it('shows the pending question as the second line only while awaiting a reply', () => {
  const question = { questionId: 'q-1', question: 'Which file?\nSecond line.' };

  const asking = collapsed({ state: 'awaitingReply', pendingQuestion: question });

  expect(asking).toHaveLength(2);
  expect(asking[1]).toBe('  Which file?');

  expect(collapsed({ state: 'running', pendingQuestion: question })).toEqual(
    collapsed({ state: 'running' }),
  );
});

it('shows the report summary as the second line for a stopped worker', () => {
  const bare = collapsed({ state: 'stopped' });

  expect(bare).toHaveLength(1);

  expect(collapsed({ state: 'stopped', report: { summary: 'All done.\nMore.' } })).toEqual([
    ...bare,
    '  All done.',
  ]);

  expect(collapsed({ state: 'stopped', report: {} })).toEqual(bare);

  expect(collapsed({ state: 'running', report: { summary: 'All done.' } })).toEqual(
    collapsed({ state: 'running' }),
  );
});

it('flags a failure only when the failure text is present', () => {
  const plain = collapsed({ state: 'running' })[0] ?? '';
  const flagged = collapsed({ state: 'running', failure: 'Boom.' })[0] ?? '';

  expect(flagged.startsWith(plain)).toBe(true);
  expect(flagged.length).toBeGreaterThan(plain.length);

  const added = flagged
    .slice(plain.length)
    .split('·')
    .filter((part) => part.trim() !== '');

  expect(added).toHaveLength(2);
  expect(flagged).not.toContain('Boom.');
  expect(collapsed({ state: 'running', failure: '' })[0]).toBe(plain);

  expect(expanded({ state: 'running', failure: 'Boom.' })).toContainEqual(
    expect.stringContaining('Boom.'),
  );

  expect(expanded({ state: 'running', failure: '' }).join('\n')).not.toContain('Failure');
});

it('shows a predecessor only for a starting worker that has one', () => {
  const predecessor = { predecessorTaskId: 'predecessor-abcdef01' };
  const starting = collapsed({ state: 'starting' })[0] ?? '';
  const following = collapsed({ state: 'starting', ...predecessor })[0] ?? '';

  expect(following.startsWith(starting)).toBe(true);
  expect(following).toContain(shortId(predecessor.predecessorTaskId));

  expect(collapsed({ state: 'running', ...predecessor })).toEqual(collapsed({ state: 'running' }));
  expect(collapsed({ state: 'starting', predecessorTaskId: '' })[0]).toBe(starting);
});

it('prints the deadline as zero-padded local time and drops a deadline that is not a number', () => {
  const running = collapsed({ state: 'running' })[0] ?? '';
  const withDeadline = collapsed({ state: 'running', deadline: deadlineAt })[0] ?? '';

  expect(withDeadline.startsWith(running)).toBe(true);
  expect(withDeadline).toMatch(/\b03:05\b/u);

  expect(collapsed({ state: 'running', deadline: 'soon' })[0]).toBe(running);

  expect(expanded({ state: 'running', deadline: deadlineAt })).toContainEqual(
    expect.stringMatching(/\b03:05\b/u),
  );

  expect(expanded({ state: 'running', deadline: 'soon' }).join('\n')).not.toContain('Deadline');
});

it('keeps every saved field when the details are parsed and expanded', () => {
  const records = join(homedir(), 'records');

  const lines = expanded({
    state: 'stopped',
    taskId: 'task-abcdef0123',
    name: 'worker-ab',
    outcome: 'success',
    successorTaskId: 'successor-1',
    predecessorTaskId: 'predecessor-1',
    failure: 'Startup failed.',
    cleanup: 'Closed the pane.',
    recovery: { paneId: 'pane-1', directory: '/elsewhere' },
    report: {
      outcome: 'success',
      summary: 'Fixed the loader.',
      evidence: ['Ran the test.', 7, 'Checked the diff.'],
    },
    pendingQuestion: { questionId: 'q-1', question: 'Which file?' },
    directory: records,
    nativeSessionFile: join(records, 'session.jsonl'),
    nativeSessionId: 'native-1',
  });

  const values = [
    'task-abcdef0123',
    'success',
    'q-1',
    'Which file?',
    'success',
    'predecessor-1',
    'successor-1',
    'Startup failed.',
    'Closed the pane.',
    'pane-1',
    'Fixed the loader.',
    'Ran the test.',
    'Checked the diff.',
    'Changes, Evidence, Decisions, Concerns',
    '~/records',
    '~/records/session.jsonl',
    'successor-1',
  ];

  for (const value of values) {
    expect(lines).toContainEqual(expect.stringContaining(value));

    const row = lines.find((line) => line.includes(value));

    expect(row).toMatch(/^[A-Za-z][A-Za-z -]*: /u);
  }
});

it('drops evidence entries that are not text', () => {
  const withReport = (evidence: unknown[]) =>
    expanded({ state: 'stopped', report: { summary: 'Done.', evidence } });

  expect(withReport(['Ran the test.', 7, null, 'Checked the diff.'])).toEqual(
    withReport(['Ran the test.', 'Checked the diff.']),
  );
});

it('shows the native session ID only when no session file is saved', () => {
  const withId = expanded({ state: 'running', nativeSessionId: 'native-1' });

  expect(withId).toContain('Native session ID: native-1');
  expect(withId.join('\n')).not.toContain('Session:');

  const emptyFile = expanded({ state: 'running', nativeSessionFile: '', nativeSessionId: '' });

  expect(emptyFile.join('\n')).not.toContain('ession');

  const both = expanded({
    state: 'running',
    nativeSessionFile: '/tmp/s.jsonl',
    nativeSessionId: 'native-1',
  });

  expect(both).toContain('Session: /tmp/s.jsonl');
  expect(both.join('\n')).not.toContain('Native session ID');
});

it('lists missing handover sections of a saved report', () => {
  const lines = expanded({ state: 'stopped', report: { outcome: 'success', summary: 'Done.' } });

  expect(lines.some((line) => line.startsWith('Handover sections missing: '))).toBe(true);
});

it('summarizes a question receipt by reply and acknowledgement state', () => {
  const receipt = (value: unknown) =>
    expanded({ state: 'running', questionReceipt: value }).find((line) =>
      line.startsWith('Question receipt:'),
    );

  const parts = (value: unknown) => receipt(value)?.split(' · ') ?? [];

  const replied = parts({
    question: { questionId: 'q-1' },
    reply: { text: 'ok' },
    acknowledgement: {},
  });

  const unanswered = parts({ question: { questionId: 'q-1' } });

  expect(replied).toHaveLength(3);
  expect(unanswered).toHaveLength(3);
  expect(replied[0]).toBe(unanswered[0]);
  expect(replied[0]).toMatch(/q-1$/u);
  expect(replied[1]).not.toBe(unanswered[1]);
  expect(replied[2]).not.toBe(unanswered[2]);
  expect(parts({ question: { questionId: 'q-1' }, reply: null })).toEqual(unanswered);

  const unknown = parts({});

  expect(unknown.slice(1)).toEqual(unanswered.slice(1));
  expect(unknown[0]).not.toBe(unanswered[0]);
  expect(unknown[0]?.replace('Question receipt:', '').trim()).not.toBe('');
  expect(unknown[0]).not.toContain('undefined');
  expect(receipt('receipt')).toBeUndefined();
});

it('renders a reply receipt with the acknowledgement the worker saved', () => {
  const reply = { replyAccepted: true, taskId: 'task-1', questionId: 'q-1' };

  const lines = (details: unknown) =>
    renderReplyResult(details, true, theme)
      .render(200)
      .map((line) => line.trimEnd());

  expect(lines(reply)).toEqual(['Task: task-1', 'Question ID: q-1']);
  expect(lines({ ...reply, workerAcknowledged: true })).toContain('Acknowledged: yes');
  expect(lines({ ...reply, workerAcknowledged: false })).toContain('Acknowledged: no');

  expect(lines({ ...reply, workerAcknowledged: 'yes' })).toEqual([
    'Task: task-1',
    'Question ID: q-1',
  ]);

  expect(lines({ replyAccepted: true })).toEqual(['Task: unknown']);

  const collapsedReply = renderReplyResult({ ...reply, workerAcknowledged: 'yes' }, false, theme)
    .render(200)
    .map((line) => line.trimEnd());

  const collapsedFor = (workerAcknowledged: unknown) =>
    renderReplyResult({ ...reply, workerAcknowledged }, false, theme)
      .render(200)
      .map((line) => line.trimEnd());

  expect(collapsedReply).toHaveLength(1);
  expect(collapsedReply[0]).toContain('task-1');
  expect(collapsedReply).toEqual(collapsedFor(undefined));
  expect(collapsedFor(true)).not.toEqual(collapsedReply);
  expect(collapsedFor(false)).toEqual(collapsedReply);
});

it('renders an unreadable-evidence notice with or without a pane and a records directory', () => {
  const bare = collapsed({ evidenceError: 'Bad record.' });
  const withPane = collapsed({ evidenceError: 'Bad record.', recovery: { paneId: 'pane-3' } });

  expect(bare).toHaveLength(1);
  expect(bare[0]).not.toContain('undefined');
  expect(collapsed({ evidenceError: 'Bad record.', recovery: { paneId: '' } })).toEqual(bare);
  expect(withPane).toHaveLength(1);
  expect(withPane[0]).toContain('pane-3');
  expect(withPane).not.toEqual(bare);

  const bareRows = expanded({ evidenceError: 'Bad record.' });

  expect(bareRows).toHaveLength(2);
  expect(bareRows[0]).toMatch(/^Task: \S/u);
  expect(bareRows[1]).toMatch(/^[A-Za-z ]+: Bad record\.$/u);
  expect(expanded({ evidenceError: 'Bad record.', recovery: { directory: '' } })).toEqual(bareRows);

  expect(
    expanded({
      taskId: 'task-1',
      evidenceError: 'Bad record.',
      recovery: { paneId: 'pane-3', directory: join(homedir(), 'records') },
    }),
  ).toEqual(['Task: task-1', 'Pane: pane-3', 'Evidence error: Bad record.', 'Records: ~/records']);
});

it('leaves a result without a renderable state to Pi default rendering', () => {
  expect(() => renderStatusResult({ state: 'bogus' }, false, theme)).toThrow(
    DefaultRenderingRequiredError,
  );

  expect(() => renderStatusResult({ state: ['running'] }, false, theme)).toThrow(
    DefaultRenderingRequiredError,
  );

  expect(renderNotice({ state: ['running'] }, false, theme)).toBeUndefined();
  expect(renderNotice({ state: 'bogus' }, false, theme)).toBeUndefined();
  expect(renderNotice('text', false, theme)).toBeUndefined();

  expect(renderNotice({ state: 'running' }, false, theme)?.render(200)[0]?.trimEnd()).toBe(
    '● worker running',
  );
});

it('prints a call line with no detail text while arguments stream in', () => {
  const lines = (detail: string | undefined) =>
    callText('Worker status', detail, theme)
      .render(200)
      .map((line) => line.trimEnd());

  expect(lines(shortId(undefined))).toEqual(['Worker status']);
  expect(lines(firstLine(undefined))).toEqual(['Worker status']);
  expect(lines(undefined)).toEqual(['Worker status']);
  expect(lines('task-abc')).toEqual(['Worker status', 'task-abc']);
});

it('ignores saved fields of the wrong type and empty IDs', () => {
  expect(collapsed({ state: 'running', taskId: 5 })).toEqual(['● worker running']);
  expect(expanded({ state: 'running', taskId: 5 })[0]).toBe('Task: unknown');
  expect(collapsed({ state: 'running', taskId: '' })).toEqual(['● worker running']);

  const stopped = { state: 'stopped', taskId: 'task-1', report: { summary: 'Done.' } };

  const followUp = expanded(stopped).find((line) => line.startsWith('Follow-up: '));

  expect(followUp).toContain('task-1');
  expect(expanded({ ...stopped, successorTaskId: '' })).toEqual(expanded(stopped));
  expect(expanded({ ...stopped, successorTaskId: 'next-1' })).not.toContain(followUp);
});

it('leaves a value that is not an object to Pi default rendering', () => {
  for (const details of [null, undefined, 'text']) {
    expect(() => renderStatusResult(details, false, theme)).toThrow(DefaultRenderingRequiredError);
    expect(() => renderReplyResult(details, false, theme)).toThrow(DefaultRenderingRequiredError);
    expect(renderNotice(details, false, theme)).toBeUndefined();
  }
});

it('shows the name of a worker whose evidence is unreadable', () => {
  const unnamed = collapsed({ evidenceError: 'Bad record.' });

  expect(unnamed[0]).toContain('worker');

  expect(collapsed({ name: 'worker-ab', evidenceError: 'Bad record.' })).toEqual(
    unnamed.map((line) => line.replace('worker', 'worker-ab')),
  );
});

it('shortens the records path only inside the home directory', () => {
  const records = (directory: string) =>
    expanded({ state: 'running', directory }).find((line) => line.startsWith('Records:'));

  expect(records('')).toBe('Records: unknown');
  expect(records(homedir())).toBe('Records: ~');
  expect(records(join(homedir(), 'records'))).toBe('Records: ~/records');
  expect(records('/elsewhere/records')).toBe('Records: /elsewhere/records');
});

it('does not shorten a path to the home mark when the home directory is the filesystem root', () => {
  home.override = '/';

  try {
    expect(expanded({ state: 'running', directory: '/' })).toContain('Records: /');

    expect(expanded({ state: 'running', directory: '/var/records' })).toContain(
      'Records: /var/records',
    );
  } finally {
    home.override = undefined;
  }
});

it('renders every line of a multi-line notice', () => {
  const render = (details: unknown) =>
    renderNotice(details, false, theme)
      ?.render(200)
      .map((line) => line.trimEnd()) ?? [];

  const lines = render({ state: 'cleanupUnconfirmed' });
  const withPane = render({ state: 'cleanupUnconfirmed', recovery: { paneId: 'pane-1' } });

  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(collapsed({ state: 'cleanupUnconfirmed' })[0]);
  expect(lines[1]).toMatch(/^ {2}\S/u);
  expect(lines[1]).not.toContain('undefined');
  expect(withPane[0]).toBe(lines[0]);
  expect(withPane[1]).toContain('pane-1');
  expect(withPane[1]).not.toBe(lines[1]);
});
