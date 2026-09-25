import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { renderWorkerWidget, workerElapsed, workerRightTime } from './widget.js';
import type { WorkerWidgetRow } from './widget.js';

const now = 120_000;
const theme = { fg: (_color: string, text: string) => text };

const row: WorkerWidgetRow = {
  name: 'worker-ab',
  taskId: 'task-full-id',
  task: 'Inspect a worker.',
  state: 'running',
  deadline: 210_000,
  createdAt: 60_000,
  activity: 'tool: read',
  activityAt: 100_000,
  usage: { available: false, reason: 'Pi session usage was not recorded' },
};

describe('worker widget', () => {
  it('shows worker name, short task name, model, status, and elapsed time in the compact widget', () => {
    const labelledRow: WorkerWidgetRow = {
      ...row,
      label: 'Inspect worker',
      model: 'Pi-selected openai-codex/gpt-5.6-luna · requested openai-codex/gpt-5.6-luna',
    };

    const lines = renderWorkerWidget([labelledRow], 80, now, theme as never);
    const text = lines.join('\n');

    expect(text).toContain('1 live');
    expect(text).toContain('worker-ab');
    expect(text).toContain('Inspect worker');
    expect(text).toContain('openai-codex/gpt-5.6-luna');
    expect(text).toContain('running');
    expect(lines.at(-1)).toMatch(/╰─+╯$/u);
    expect(lines).toHaveLength(3);
    expect(text).toContain('01:00');
    expect(text).not.toContain('left');
  });

  it.each(['investigator', 'code-critic'])('keeps the suffix of truncated %s names', (prefix) => {
    const rows = [
      { ...row, name: `${prefix}-ab`, taskId: 'ab' },
      { ...row, name: `${prefix}-cd`, taskId: 'cd' },
    ];

    const text = stripTerminalSequences(
      renderWorkerWidget(rows, 28, now, theme as never).join('\n'),
    );

    expect(text).not.toContain(`${prefix}-ab`);
    expect(text).toContain('…-ab');
    expect(text).toContain('…-cd');
  });

  it('keeps long names, task labels, models, and status readable when width allows', () => {
    const longRow: WorkerWidgetRow = {
      ...row,
      name: 'scout-abcdef',
      label: 'Reading the subagent controller source',
      state: 'running',
      model: 'Pi-selected openai-codex/gpt-5.6-luna · requested openai-codex/gpt-5.6-luna',
    };

    const lines = renderWorkerWidget([longRow], 160, now, theme as never);
    const text = stripTerminalSequences(lines.join('\n'));

    expect(text).toContain('scout-abcdef');
    expect(text).toContain('Reading the subagent controller source');
    expect(text).toContain('openai-codex/gpt-5.6-luna');
    expect(text).not.toContain('…');
    expect(text).not.toContain('/subagents');
  });

  it('keeps the column order name, status, task, model with slack after the last column', () => {
    const modelRow: WorkerWidgetRow = {
      ...row,
      label: 'Inspect a worker',
      model: 'Pi-selected openai-codex/gpt-5.6-luna · requested openai-codex/gpt-5.6-luna',
    };

    for (const width of [160, 300]) {
      const lines = renderWorkerWidget([modelRow], width, now, theme as never);
      const rowLine = lines.find((line) => line.includes(row.name)) ?? '';
      const content = stripTerminalSequences(rowLine).slice(2, -2).trimEnd();

      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(content).toBe('worker-ab running 01:00 Inspect a worker openai-codex/gpt-5.6-luna');
    }
  });

  it('shows aligned columns, drops the model first when narrow, and stops at terminal width', () => {
    const rows: WorkerWidgetRow[] = [
      { ...row, name: 'worker-k7', label: 'Read config', model: 'Pi-selected gpt-6' },
      {
        ...row,
        name: 'scout-p2',
        label: 'Trace herdr',
        model: 'Pi-selected gpt-6',
      },
      {
        ...row,
        name: 'worker-c2',
        taskId: 'question',
        label: 'Choose file',
        state: 'awaitingReply',
        question: 'Choose a file',
        createdAt: 105_000,
      },
      {
        ...row,
        name: 'worker-ge',
        taskId: 'recovery',
        label: 'Inspect recovery',
        state: 'cleanupUnconfirmed',
        activityAt: 110_000,
        createdAt: 110_000,
        issue: 'Inspect recovery evidence',
      },
      ...Array.from({ length: 6 }, (_value, index) => ({
        ...row,
        name: `worker-${String(index).padStart(2, '0')}`,
        taskId: `stopped-${index}`,
        label: `Finished ${index}`,
        state: 'stopped' as const,
        stoppedAt: 110_000,
      })),
    ];

    const wide = renderWorkerWidget(rows, 72, now, theme as never);
    const narrow = renderWorkerWidget(rows, 45, now, theme as never);

    expect(wide[0]).toContain('2 live · 1 cleanup unconfirmed · 1 waiting for reply');
    expect(wide.at(-1)).toContain('6 stopped');
    expect(wide.at(-1)).not.toContain('/subagents');
    expect(wide).toHaveLength(5);
    expect(narrow.every((line) => visibleWidth(line) <= 45)).toBe(true);
    expect(wide.every((line) => visibleWidth(line) === 72)).toBe(true);
    expect(narrow.at(-1)).toContain('6 stopped');
    expect(narrow.some((line) => line.includes('unconfirmed'))).toBe(true);
    expect(narrow.some((line) => line.includes('asks · waiting'))).toBe(true);
    expect(wide.some((line) => line.includes('gpt-6'))).toBe(true);
    expect(narrow.some((line) => line.includes('gpt-6'))).toBe(false);
    expect(wide.join('\n')).not.toContain('worker-00');
    expect(wide.join('\n')).not.toContain('worker-ge');

    const firstPosition = wide.findIndex((line) => line.includes('worker-k7'));
    const secondPosition = wide.findIndex((line) => line.includes('scout-p2'));
    const thirdPosition = wide.findIndex((line) => line.includes('worker-c2'));

    expect(firstPosition).toBeLessThan(secondPosition);
    expect(secondPosition).toBeLessThan(thirdPosition);
    expect(wide.at(-1)).toContain('6 stopped');
  });

  it('keeps historical unresolved records out of the rows but keeps them in the counts', () => {
    const rows: WorkerWidgetRow[] = [
      {
        ...row,
        name: 'worker-aa',
        taskId: 'stopped-question',
        state: 'stopped',
        stoppedAt: 90_000,
        question: 'Choose a file',
      },
      {
        ...row,
        name: 'worker-bb',
        taskId: 'stopped-issue',
        state: 'stopped',
        stoppedAt: 90_000,
        issue: 'Parent exited',
      },
      { ...row, name: 'scout-cc', taskId: 'active-1' },
      { ...row, name: 'worker-dd', taskId: 'recovery', state: 'notOwned' },
    ];

    const lines = renderWorkerWidget(rows, 80, now, theme as never);
    const text = lines.join('\n');

    expect(lines[0]).toContain('1 live · 1 status unknown');
    expect(lines.at(-1)).toContain('2 stopped');
    expect(text).toContain('scout-cc');
    expect(text).not.toContain('worker-dd');
    expect(text).not.toContain('worker-aa');
    expect(text).not.toContain('worker-bb');
  });

  it('labels unresolved workers with explicit counts instead of a generic attention label', () => {
    const unresolved: WorkerWidgetRow[] = [
      { ...row, name: 'worker-3b', taskId: 'unknown-owner', state: 'unknown' },
      { ...row, name: 'worker-c2', taskId: 'not-owned', state: 'notOwned' },
      { ...row, name: 'worker-q8', taskId: 'cleanup-1', state: 'cleanupUnconfirmed' },
      { ...row, name: 'worker-ge', taskId: 'cleanup-2', state: 'cleanupUnconfirmed' },
    ];

    const lines = renderWorkerWidget(unresolved, 200, now, theme as never);
    const text = lines.join('\n');

    expect(lines).toHaveLength(1);
    expect(text).toContain('no active workers');
    expect(text).toContain('2 status unknown');
    expect(text).toContain('2 cleanup unconfirmed');
    expect(text).not.toContain('need you');
    expect(text).not.toContain('stopped');
    expect(text).not.toContain('worker-3b');
  });

  it('keeps retained questions on unresolved workers out of the waiting count', () => {
    const retained: WorkerWidgetRow[] = [
      {
        ...row,
        name: 'worker-3b',
        taskId: 'unknown-owner',
        state: 'unknown',
        question: 'Old question A',
        questionId: 'q-a',
      },
      {
        ...row,
        name: 'worker-c2',
        taskId: 'not-owned',
        state: 'notOwned',
        question: 'Old question B',
        questionId: 'q-b',
      },
      {
        ...row,
        name: 'worker-q8',
        taskId: 'cleanup-1',
        state: 'cleanupUnconfirmed',
        question: 'Old question C',
        questionId: 'q-c',
      },
    ];

    const text = renderWorkerWidget(retained, 200, now, theme as never).join('\n');

    expect(text).toContain('2 status unknown');
    expect(text).toContain('1 cleanup unconfirmed');
    expect(text).not.toContain('waiting');
    expect(text).not.toContain('asks');
  });

  it('keeps every current attention row when old unresolved and stopped records exist', () => {
    const rows: WorkerWidgetRow[] = [
      { ...row, name: 'worker-aa', taskId: 'active-1', state: 'running' },
      {
        ...row,
        name: 'worker-bb',
        taskId: 'waiting-1',
        state: 'awaitingReply',
        question: 'Choose a file',
      },
      ...Array.from({ length: 6 }, (_value, index) => ({
        ...row,
        name: `worker-${String(index).padStart(2, '0')}`,
        taskId: `old-${index}`,
        state: index < 3 ? ('cleanupUnconfirmed' as const) : ('stopped' as const),
        stoppedAt: 90_000,
      })),
    ];

    const text = renderWorkerWidget(rows, 160, now, theme as never).join('\n');

    expect(text).toContain('worker-aa');
    expect(text).toContain('worker-bb');
    expect(text).not.toContain('worker-00');
    expect(text).toContain('3 cleanup unconfirmed');
    expect(text).toContain('3 stopped');
  });

  it('counts reported and issue-bearing workers as live instead of dropping them', () => {
    const active: WorkerWidgetRow[] = [
      { ...row, name: 'worker-aa', taskId: 'reported-1', state: 'reported' },
      {
        ...row,
        name: 'worker-bb',
        taskId: 'issue-1',
        state: 'running',
        issue: 'parent needs a decision',
      },
    ];

    const text = renderWorkerWidget(active, 160, now, theme as never).join('\n');

    expect(text).toContain('2 live');
    expect(text).not.toContain('status unknown');
    expect(text).not.toContain('cleanup unconfirmed');
    expect(text).not.toContain('waiting for reply');
    expect(text).toContain('worker-aa');
    expect(text).toContain('worker-bb');
  });

  it('shows a stopped-only count as one muted summary line without old rows', () => {
    const lines = renderWorkerWidget(
      [
        { ...row, name: 'worker-aa', state: 'stopped' },
        { ...row, name: 'worker-bb', state: 'stopped' },
      ],
      80,
      now,
      theme as never,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no active workers');
    expect(lines[0]).toContain('2 stopped');
    expect(lines[0]).not.toContain('0 live');
    expect(lines.join('\n')).not.toContain('worker-aa');
  });

  it('limits collapsed rows and reports only omitted live or attention workers', () => {
    const rows: WorkerWidgetRow[] = Array.from({ length: 8 }, (_value, index) => ({
      ...row,
      name: `worker-${String(index).padStart(2, '0')}`,
      taskId: `task-${index}`,
      createdAt: index,
      state: index < 3 ? 'stopped' : 'running',
    }));

    const lines = renderWorkerWidget(rows, 80, now, theme as never);

    expect(lines.at(-1)).toContain('3 stopped');
    expect(lines.some((line) => line.includes('+ 1 more workers'))).toBe(true);
    expect(lines.join('\n')).not.toContain('worker-00');
  });

  it('keeps tiny widget widths bounded and strips controls from activity labels', () => {
    const hostileRow = {
      ...row,
      activity: 'herdr working\u001b[2J\u0007',
    };

    const wideLines = renderWorkerWidget([hostileRow], 72, now, theme as never);

    expect(wideLines.join('\n')).not.toContain('\u001b[2J');
    expect(wideLines.join('\n')).not.toContain('\u0007');
    expect(wideLines.join('\n')).toContain('herdr working');

    for (const width of [0, 1, 2, 4, 16]) {
      const lines = renderWorkerWidget([hostileRow], width, now, theme as never);

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    const stoppedOnly = renderWorkerWidget(
      [{ ...row, state: 'stopped', stoppedAt: now }],
      16,
      now,
      theme as never,
    );

    expect(stoppedOnly.every((line) => visibleWidth(line) <= 16)).toBe(true);
  });

  it('strips terminal controls from a task-derived label before truncation', () => {
    const hostileRow: WorkerWidgetRow = {
      ...row,
      label: undefined,
      task: `# ${'a'.repeat(10)}\u001b[2Jb\u0007c\td\r e\u0000f${'b'.repeat(80)}`,
    };

    const lines = renderWorkerWidget([hostileRow], 200, now, theme as never);
    const text = lines.join('\n');

    expect(text).not.toContain('\u001b[2J');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\t');
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\u0000');
    expect(text).toContain('aaaaaaaaaa');
    expect(lines.every((line) => visibleWidth(line) === 200)).toBe(true);
  });

  it('pads the row after the last column instead of stretching the task column', () => {
    const lines = renderWorkerWidget([row], 72, now, theme as never);
    const rowLine = lines.find((line) => line.includes(row.name));

    if (rowLine == null) {
      throw new TypeError('Expected a live worker row.');
    }

    const content = stripTerminalSequences(rowLine).slice(2, -2);

    expect(content.endsWith(' ')).toBe(true);
    expect(content.trimEnd()).toBe('worker-ab running 01:00 Inspect a worker. —');
  });

  it('does not claim run time or a live countdown for uncertain states', () => {
    const uncertain = { ...row, state: 'cleanupUnconfirmed' as const };
    const unknown = { ...row, state: 'unknown' as const };

    const stopped = {
      ...row,
      state: 'stopped' as const,
      cleanupConfirmed: true,
      stoppedAt: 90_000,
    };

    expect(workerElapsed(uncertain, now)).toBe('--:--');
    expect(workerRightTime(uncertain, now)).toMatch(/^@\d{2}:\d{2}$/u);
    expect(workerElapsed(unknown, now)).toBe('--:--');
    expect(workerRightTime(unknown, now)).toMatch(/^@\d{2}:\d{2}$/u);
    expect(workerRightTime(unknown, now)).not.toContain('left');
    expect(workerRightTime({ ...row, deadline: now - 1 }, now)).toBe('overdue');
    expect(workerElapsed(stopped, now)).toBe('00:30');
    expect(workerRightTime(stopped, now)).toMatch(/^@\d{2}:\d{2}$/u);
  });
});
