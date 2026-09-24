import {
  TuiMainScreen,
  VStack,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import type { WorkerWidgetRow } from './widget.js';
import { WorkerHistoryView, openWorkerHistory } from './widgetOverlay.js';

const noOperation = (): void => undefined;
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const keybindings = {
  matches: (data: string, action: string): boolean => {
    if (action === 'tui.select.cancel') {
      return data === '\u001b' || data === '\u0003';
    }

    if (action === 'tui.select.confirm') {
      return data === '\r';
    }

    if (action === 'tui.select.up') {
      return data === '\u001b[A';
    }

    if (action === 'tui.select.down') {
      return data === '\u001b[B';
    }

    return false;
  },
};

const now = Date.now();
const rows: WorkerWidgetRow[] = Array.from({ length: 30 }, (_value, index) => {
  let state: WorkerWidgetRow['state'] = 'stopped';

  if (index < 10) {
    state = 'cleanupUnconfirmed';
  } else if (index < 20) {
    state = 'running';
  }

  return {
    name: `worker-${String(index).padStart(2, '0')}`,
    taskId: `task-full-${index}`,
    task: `Bounded task ${index}`,
    state,
    deadline: now + 21 * 60_000,
    createdAt: now - (index + 1) * 60_000,
    stoppedAt: state === 'stopped' ? now - 20_000 : undefined,
    activityAt: state === 'cleanupUnconfirmed' ? now - 20_000 : undefined,
    outcome: state === 'stopped' ? 'success' : undefined,
    issue: state === 'cleanupUnconfirmed' ? 'inspect recovery reference' : undefined,
    question: index === 0 ? 'Confirm recovered process identity.' : undefined,
    questionId: index === 0 ? 'question-full-0' : undefined,
    detailPath: `/records/task-full-${index}/report.json`,
    report: { summary: `Completed task ${index}`, evidence: [`Evidence file ${index}`] },
    details: 'Pi trusted tools + verified safety',
    recovery:
      state === 'cleanupUnconfirmed' ? 'Pane worker-01 may still exist. No retry.' : undefined,
    workerType: 'Pi worker',
    model: 'Pi-selected openai-codex/gpt-6-luna · requested openai-codex/gpt-6-luna',
    usage: { available: false, reason: 'Pi session usage was not recorded' },
  };
});

const createTerminal = (inputHandler: { current?: (input: string) => void }): Terminal => ({
  start: (onInput: (input: string) => void) => {
    inputHandler.current = onInput;
  },
  stop: () => undefined,
  drainInput: async () => undefined,
  write: () => undefined,
  get columns() {
    return 80;
  },
  get rows() {
    return 12;
  },
  get kittyProtocolActive() {
    return false;
  },
  moveBy: () => undefined,
  hideCursor: () => undefined,
  showCursor: () => undefined,
  clearLine: () => undefined,
  clearFromCursor: () => undefined,
  clearScreen: () => undefined,
  setTitle: () => undefined,
  setProgress: () => undefined,
});

it('filters history by task ID and clears the filter with escape', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    rows,
    noOperation,
  );

  view.handleInput('/');

  for (const character of 'task-full-29') {
    view.handleInput(character);
  }

  const filtered = view.render(72).join('\n');

  expect(filtered).toContain('1 workers');
  expect(filtered).toContain('worker-29');
  expect(filtered).not.toContain('worker-28');

  view.handleInput('\u001b');

  expect(view.render(72).join('\n')).toContain('30 workers');
});

it('filters history by the displayed short task label', () => {
  const labelled: WorkerWidgetRow[] = [
    { ...rows[10]!, label: 'Rename pane titles', task: 'Implement the complete outcome.' },
    { ...rows[11]!, label: 'Fix status counts', task: 'Implement the complete outcome.' },
  ];
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    labelled,
    noOperation,
  );

  view.handleInput('/');

  for (const character of 'rename pane') {
    view.handleInput(character);
  }

  const filtered = view.render(72).join('\n');

  expect(filtered).toContain('1 workers');
  expect(filtered).toContain('Rename pane titles');
  expect(filtered).not.toContain('Fix status counts');
});

it('marks cleanup-unconfirmed activity times as clock values', () => {
  const cleanupRow = {
    ...rows[0]!,
    name: 'worker-clock',
    activityAt: now,
  };
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [cleanupRow],
    noOperation,
  );
  const rowLine = view.render(72).find((line) => line.includes('worker-clock')) ?? '';

  expect(rowLine).toMatch(/@\d{2}:\d{2}/u);
  expect(rowLine).not.toContain('seen');
});

it('keeps approved-width detail timing on one aligned value row', () => {
  const detailRow: WorkerWidgetRow = {
    ...rows[1]!,
    createdAt: now - 6 * 60 * 60_000 - 15 * 60_000,
    deadline: now - 50 * 60_000,
    question: undefined,
    questionId: undefined,
    issue: undefined,
  };
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [detailRow],
    noOperation,
  );

  view.handleInput('\r');
  const timeLine = view.render(66).find((line) => line.includes('Time')) ?? '';

  expect(timeLine).toContain('run time unknown · deadline passed');
});

it('uses the full available width for history rows and details', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [rows[10]!],
    noOperation,
  );

  for (const width of [160, 200]) {
    const listLines = view.render(width);

    expect(listLines.every((line) => visibleWidth(line) === width)).toBe(true);
    view.handleInput('\\r');
    const detailLines = view.render(width);
    expect(detailLines.every((line) => visibleWidth(line) === width)).toBe(true);
    view.handleInput('\\u001b');
  }
});

it('right-aligns live countdowns against the history border', () => {
  const liveView = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [rows[10]!],
    noOperation,
  );
  const liveRow = liveView.render(72).find((line) => line.includes('worker-10')) ?? '';

  expect(stripTerminalSequences(liveRow)).toMatch(/21m left │$/u);
});

it('does not claim run time from an unconfirmed stopped timestamp', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [
      {
        ...rows[29]!,
        state: 'stopped',
        stoppedAt: now - 60_000,
        cleanupConfirmed: false,
      },
    ],
    noOperation,
  );

  view.handleInput('\r');
  const details = view.render(72).join('\n');

  expect(details).toContain('run time unknown');
  expect(details).not.toContain('ran 1m');
});

it('shows a distinct message for an empty unfiltered history', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [],
    noOperation,
  );

  expect(view.render(72).join('\n')).toContain('No worker records yet.');
});

it('keeps details readable, aligned, sanitized, and within narrow and tiny widths', () => {
  const detailedRow: WorkerWidgetRow = {
    ...rows[0]!,
    task: 'Inspect this unicode worker history row and preserve every word. 漢字',
    state: 'stopped',
    createdAt: now - 300 * 60_000,
    stoppedAt: now - 73 * 60_000,
    cleanupConfirmed: true,
    deadline: now - 60_000,
    details: 'Pi trusted tools + verified safety',
    recovery: 'No recovery action required.',
    workerType: 'Pi worker',
    model: 'Pi-selected openai-codex/gpt-6-luna · requested openai-codex/gpt-6-luna',
    detailPath: `/records/${'very-long-path-'.repeat(8)}task.json`,
  };
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [detailedRow],
    noOperation,
  );

  view.handleInput('\r');
  view.handleInput('p');
  view.handleInput('g');
  const renderedPages = [view.render(45)];

  for (let index = 0; index < 80; index += 1) {
    view.handleInput('\u001b[B');
    renderedPages.push(view.render(45));
  }

  const lines = renderedPages.flat();
  const text = stripTerminalSequences(lines.join('\n'))
    .replace(/[│╭╮╰─]/gu, ' ')
    .replace(/\s+/gu, ' ');
  const stateValue = lines.find((line) => line.includes('State')) ?? '';
  const safetyValue = lines.find((line) => line.includes('Safety')) ?? '';

  expect(lines.every((line) => visibleWidth(line) <= 45)).toBe(true);
  const compactText = text.replace(/\s/gu, '');

  expect(compactText).toContain('Inspectthisunicodeworkerhistoryrowandpreserveeveryword.漢字');
  expect(text).toContain('Safety');
  expect(text).toContain('No recovery action required.');
  expect(compactText).toContain('requestedopenai-codex/gpt-6-luna');
  expect(compactText).toContain('observedPi-selectedopenai-codex/gpt-6-luna');
  expect(text).toMatch(/started \d{2}:\d{2} · ran 227m · deadline passed/u);
  expect(stateValue.indexOf('stopped')).toBe(safetyValue.indexOf('Pi trusted'));

  for (const width of [0, 1, 2, 4, 16]) {
    expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
});

it('keeps the selected task when fresh rows resort after a worker stops', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    rows,
    noOperation,
  );

  expect(view).toHaveProperty('setRows');
  view.handleInput('g');

  for (let index = 0; index < 15; index += 1) {
    view.handleInput('j');
  }

  view.handleInput('\r');
  expect(view.render(72).join('\n')).toContain('worker-15 · Pi worker');

  const refreshedRows = rows.map((row) =>
    row.taskId === 'task-full-15'
      ? { ...row, state: 'stopped' as const, outcome: 'failure', stoppedAt: now }
      : row,
  );
  const changedRows = [
    ...refreshedRows,
    { ...rows[0]!, taskId: 'task-new-attention', name: 'worker-new', question: 'Choose a tool.' },
  ];
  const mutableView = view as unknown as { setRows(nextRows: WorkerWidgetRow[]): void };

  mutableView.setRows(changedRows);
  const details = view.render(72).join('\n');

  expect(details).toContain('worker-15 · Pi worker');
  expect(details).toContain('21 of 31');
  expect(details).toContain('failure');
});

it('shows the model column when width allows, hides it when narrow, and keeps full detail', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [rows[10]!],
    noOperation,
  );
  const wide = view.render(160).join('\n');

  expect(wide).toContain('openai-codex/gpt-6-luna');

  const narrow = view.render(60).join('\n');

  expect(narrow).not.toContain('openai-codex/gpt-6-luna');

  view.handleInput('\r');
  expect(view.render(60).join('\n')).toContain('openai-codex/gpt-6-luna');
});

it('groups unresolved records under their exact state instead of a generic label', () => {
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [rows[0]!, rows[25]!],
    noOperation,
  );
  const rendered = view.render(120).join('\n');

  expect(rendered).toContain('CLEANUP UNCONFIRMED');
  expect(rendered).toContain('STOPPED');
  expect(rendered).not.toContain('NEEDS YOU');
});

it('keeps interleaved attention groups contiguous and every worker reachable', () => {
  const base = rows[0]!;
  const interleaved: WorkerWidgetRow[] = [
    { ...base, name: 'worker-c1', taskId: 't-c1', state: 'cleanupUnconfirmed', createdAt: 50 },
    { ...base, name: 'worker-u1', taskId: 't-u1', state: 'unknown', createdAt: 40 },
    {
      ...base,
      name: 'worker-w1',
      taskId: 't-w1',
      state: 'running',
      createdAt: 30,
      question: 'Pending decision',
    },
    { ...base, name: 'worker-c2', taskId: 't-c2', state: 'cleanupUnconfirmed', createdAt: 60 },
    { ...base, name: 'worker-u2', taskId: 't-u2', state: 'notOwned', createdAt: 20 },
    {
      ...base,
      name: 'worker-w2',
      taskId: 't-w2',
      state: 'awaitingReply',
      createdAt: 10,
      question: 'Another decision',
    },
  ];
  const view = new WorkerHistoryView(
    { terminal: { rows: 40 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    interleaved,
    noOperation,
  );
  const lines = view.render(120);
  const text = lines.join('\n');
  const headingCount = (heading: string): number =>
    lines.filter((line) => {
      const plain = stripTerminalSequences(line);

      return plain.includes(heading) && !plain.includes('worker-');
    }).length;

  expect(headingCount('STATUS UNKNOWN')).toBe(1);
  expect(headingCount('CLEANUP UNCONFIRMED')).toBe(1);
  expect(headingCount('WAITING FOR REPLY')).toBe(1);

  for (const name of [
    'worker-c1',
    'worker-u1',
    'worker-w1',
    'worker-c2',
    'worker-u2',
    'worker-w2',
  ]) {
    expect(text).toContain(name);
  }

  expect(text.indexOf('worker-u1')).toBeLessThan(text.indexOf('worker-u2'));
  expect(text.indexOf('worker-c2')).toBeLessThan(text.indexOf('worker-c1'));
  expect(text.indexOf('worker-w1')).toBeLessThan(text.indexOf('worker-w2'));
});

it('shows the reported phase in the list and its update time in the selected details', () => {
  const reported: WorkerWidgetRow = {
    ...rows[10]!,
    activity: 'Running focused tests',
    phaseDescription: 'Running focused tests',
    phaseDescriptionAt: now - 30_000,
  };
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [reported],
    noOperation,
  );

  expect(view.render(120).join('\n')).toContain('Running focused tests');

  view.handleInput('\r');
  const details = view.render(120).join('\n');

  expect(details).toContain('Running focused tests');
  expect(details).toMatch(/@\d{2}:\d{2}/u);
});

it('shows grouped bounded history and opens details through real TUI input', () => {
  const inputHandler: { current?: (input: string) => void } = {};
  const terminal = createTerminal(inputHandler);
  const tui = new TuiMainScreen(terminal);
  let closed = false;
  let selectedName: string | undefined;
  const view = new WorkerHistoryView(tui, theme as never, keybindings as never, rows, (name) => {
    closed = true;
    selectedName = name;
  });
  const editor = {
    render: () => ['Editor'],
    invalidate: () => undefined,
    handleInput: () => undefined,
  };
  tui.addChild(new VStack([view, editor]));
  tui.setFocus(view);
  tui.start();
  tui.renderNow();

  try {
    const firstPage = view.render(72).join('\n');
    expect(firstPage).toContain('CLEANUP UNCONFIRMED');
    expect(firstPage).not.toContain('NEEDS YOU');
    expect(firstPage).toContain('worker-');
    expect(firstPage).toContain('/30');
    expect(firstPage.split('\n')[0]).toContain('30 workers ─');
    expect(firstPage.split('\n').at(-1)).toContain('esc close ─');
    expect(firstPage).toContain('@');
    expect(view.render(72).length).toBeLessThanOrEqual(8);

    const historyRowLines = firstPage.split('\n').filter((line) => line.includes('worker-'));

    for (const line of historyRowLines) {
      expect(stripTerminalSequences(line).slice(2, -2).trimEnd()).toHaveLength(68);
    }

    inputHandler.current?.('\r');
    const questionDetails = view.render(72).join('\n');
    expect(questionDetails).toContain('Question ID');
    expect(questionDetails).toContain('question-full-0');
    inputHandler.current?.('\u001b');
    inputHandler.current?.('G');
    expect(view.render(72).join('\n')).toContain('STOPPED');
    inputHandler.current?.('\r');
    const detailLines = view.render(72);
    const details = detailLines.join('\n');

    expect(stripTerminalSequences(detailLines.at(-1) ?? '')).not.toMatch(/─\s+─╯/u);
    expect(details).toContain('worker-29 · Pi worker');
    expect(details).toContain('Task name');
    expect(details).toContain('Bounded task 29');
    expect(details).not.toContain('more workers');

    inputHandler.current?.('\u0004');
    expect(view.render(72).join('\n')).toContain('Evidence');

    for (let index = 0; index < 20; index += 1) {
      inputHandler.current?.('\u001b[B');
    }

    expect(view.render(72).join('\n')).toContain('Task ID');
    expect(view.render(72).join('\n')).toContain('task-full-29');
    inputHandler.current?.('i');
    expect(selectedName).toBe('worker-29');
    expect(closed).toBe(true);
  } finally {
    tui.stop();
  }
});

it('keeps escape sequences out of a task-derived history label', () => {
  const hostileRow: WorkerWidgetRow = {
    ...rows[10]!,
    label: undefined,
    task: `# ${'a'.repeat(10)}\u001b[2Jb\u0007c\td\r e\u0000f${'b'.repeat(80)}`,
  };
  const view = new WorkerHistoryView(
    { terminal: { rows: 24 }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    [hostileRow],
    noOperation,
  );
  const rendered = view.render(200).join('\n');

  expect(rendered).not.toContain('\u001b[2J');
  expect(rendered).not.toContain('\u001b');
  expect(rendered).not.toContain('\u0007');
  expect(rendered).not.toContain('\t');
  expect(rendered).not.toContain('\r');
  expect(rendered).not.toContain('\u0000');
  expect(rendered).toContain('aaaaaaaaaa');
});

it('pastes the selected worker name after the custom UI closes so restored editor text survives', async () => {
  const editorText = { value: 'existing draft' };
  const pasted: string[] = [];
  const fakeTui = { terminal: { rows: 24 }, requestRender: noOperation };
  const context = {
    ui: {
      custom: async (
        factory: (
          tui: unknown,
          uiTheme: unknown,
          uiKeybindings: unknown,
          done: (value: string | undefined) => void,
        ) => WorkerHistoryView,
      ): Promise<string | undefined> => {
        let result: string | undefined;
        const component = factory(fakeTui, theme, keybindings, (value) => {
          // Pi restores the saved editor text before the custom promise resolves.
          editorText.value = 'existing draft';
          result = value;
        });

        component.handleInput('\r');
        component.handleInput('i');

        return result;
      },
      pasteToEditor: (name: string) => {
        editorText.value += name;
        pasted.push(name);
      },
    },
  };

  await openWorkerHistory(context as never, rows, noOperation);

  expect(pasted).toEqual(['worker-00']);
  expect(editorText.value).toBe('existing draftworker-00');
});

it('leaves editor text untouched when the history closes without a selection', async () => {
  const editorText = { value: 'existing draft' };
  const pasted: string[] = [];
  const fakeTui = { terminal: { rows: 24 }, requestRender: noOperation };
  const context = {
    ui: {
      custom: async (
        factory: (
          tui: unknown,
          uiTheme: unknown,
          uiKeybindings: unknown,
          done: (value: string | undefined) => void,
        ) => WorkerHistoryView,
      ): Promise<string | undefined> => {
        const component = factory(fakeTui, theme, keybindings, () => undefined);

        component.handleInput('\u001b');

        return undefined;
      },
      pasteToEditor: (name: string) => {
        editorText.value += name;
        pasted.push(name);
      },
    },
  };

  await openWorkerHistory(context as never, rows, noOperation);

  expect(pasted).toEqual([]);
  expect(editorText.value).toBe('existing draft');
});

const createView = (viewRows: WorkerWidgetRow[], terminalRows = 24): WorkerHistoryView =>
  new WorkerHistoryView(
    { terminal: { rows: terminalRows }, requestRender: noOperation } as never,
    theme as never,
    keybindings as never,
    viewRows,
    noOperation,
  );

it('shows key facts first and reveals the full prompt with paragraph breaks on demand', () => {
  const promptRow: WorkerWidgetRow = {
    ...rows[10]!,
    label: 'Fix status counts',
    task: 'First paragraph line one.\nline two.\n\nSecond paragraph after a blank line.',
  };
  const view = createView([promptRow]);

  view.handleInput('\r');
  const facts = stripTerminalSequences(view.render(60).join('\n'));

  expect(facts).toContain('Task name');
  expect(facts).toContain('Fix status counts');
  expect(facts).not.toContain('Second paragraph');

  view.handleInput('p');
  const withPrompt = stripTerminalSequences(view.render(60).join('\n'));

  expect(withPrompt).toContain('Full task prompt');
  expect(withPrompt).toContain('Second paragraph after a blank line.');
  expect(withPrompt).toMatch(/line two\.[^\n]*\n│\s*│\n[^\n]*Second paragraph/u);
});

it('scrolls the details half a page with ctrl+d and ctrl+u and clamps at the top', () => {
  const longPrompt = Array.from({ length: 60 }, (_value, index) => `paragraph line ${index}`).join(
    '\n',
  );
  const view = createView([{ ...rows[10]!, task: longPrompt }]);

  view.handleInput('\r');
  view.handleInput('p');
  const atPrompt = view.render(72).join('\n');

  view.handleInput('\u0004');
  expect(view.render(72).join('\n')).not.toBe(atPrompt);

  view.handleInput('\u0015');
  expect(view.render(72).join('\n')).toBe(atPrompt);

  for (let index = 0; index < 50; index += 1) {
    view.handleInput('\u0015');
  }

  const top = view.render(72);

  expect(top.every((line) => visibleWidth(line) <= 72)).toBe(true);
  expect(top.join('\n')).toContain('Task name');
});

it('moves the history selection half a page with ctrl+d and ctrl+u', () => {
  const view = createView(rows);

  view.handleInput('g');
  const atTop = view.render(72).join('\n');

  view.handleInput('\u0004');
  expect(view.render(72).join('\n')).not.toBe(atTop);

  view.handleInput('\u0015');
  expect(view.render(72).join('\n')).toBe(atTop);
});

it('drives detail scroll through the real TUI input path', () => {
  const inputHandler: { current?: (input: string) => void } = {};
  const terminal = createTerminal(inputHandler);
  const tui = new TuiMainScreen(terminal);
  const promptRow: WorkerWidgetRow = {
    ...rows[10]!,
    label: 'Fix status counts',
    task: Array.from({ length: 40 }, (_value, index) => `prompt line ${index}`).join('\n'),
  };
  const view = new WorkerHistoryView(
    tui,
    theme as never,
    keybindings as never,
    [promptRow],
    noOperation,
  );
  const editor = {
    render: () => ['Editor'],
    invalidate: () => undefined,
    handleInput: () => undefined,
  };
  tui.addChild(new VStack([view, editor]));
  tui.setFocus(view);
  tui.start();
  tui.renderNow();

  try {
    inputHandler.current?.('\r');
    inputHandler.current?.('p');
    const promptPage = view.render(72).join('\n');

    expect(promptPage).toContain('Full task prompt');

    inputHandler.current?.('\u0004');
    expect(view.render(72).join('\n')).not.toBe(promptPage);

    inputHandler.current?.('\u0015');
    expect(view.render(72).join('\n')).toBe(promptPage);

    inputHandler.current?.('\u001b');
    expect(view.render(72).join('\n')).toContain('Subagents ·');
    expect(view.render(72).every((line) => visibleWidth(line) <= 72)).toBe(true);
  } finally {
    tui.stop();
  }
});

it('clamps ctrl+d and ctrl+u at list ends without losing the selection', () => {
  const view = createView(rows.slice(0, 3));
  const selectedName = (): string | undefined =>
    view
      .render(72)
      .find((line) => line.includes('▶'))
      ?.match(/worker-\d{2}/u)?.[0];

  view.handleInput('g');
  expect(selectedName()).toBe('worker-00');

  view.handleInput('\u0015');
  expect(selectedName()).toBe('worker-00');

  view.handleInput('j');
  expect(selectedName()).toBe('worker-01');

  view.handleInput('\u0004');
  expect(selectedName()).toBe('worker-02');

  view.handleInput('\u0004');
  expect(selectedName()).toBe('worker-02');

  view.handleInput('\r');
  expect(view.render(72).join('\n')).toContain('worker-02 · Pi worker');

  const emptyView = createView([]);

  emptyView.handleInput('\u0004');
  emptyView.handleInput('\u0015');
  expect(emptyView.render(72).join('\n')).toContain('No worker records yet.');
});

it('keeps the selected details scroll across an unchanged-selection refresh', () => {
  const scrollRow: WorkerWidgetRow = {
    ...rows[10]!,
    task: Array.from({ length: 40 }, (_value, index) => `prompt line ${index}`).join('\n'),
  };
  const view = createView([scrollRow]);

  view.handleInput('\r');
  view.handleInput('p');
  view.handleInput('\u0004');
  const before = view.render(72).join('\n');

  const mutableView = view as unknown as { setRows(nextRows: WorkerWidgetRow[]): void };

  mutableView.setRows([{ ...scrollRow }]);
  expect(view.render(72).join('\n')).toBe(before);

  mutableView.setRows([{ ...scrollRow, state: 'reported', outcome: 'success' }]);
  expect(view.render(72).join('\n')).toContain('prompt line');

  view.handleInput('g');
  expect(view.render(72).join('\n')).toContain('reported');
});
