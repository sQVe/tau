import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

import type { WorkerNoticeEvent } from '../../worker.js';
import { actionLabel, questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult } from './dialog.js';
import type { QuestionnaireState } from './questionnaire.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const problem = 'Decides how the first screen looks. Changing it later moves every panel.';
const impact = 'The answer blocks the dashboard build.';
const description = 'A long description that wraps over several lines on a narrow terminal.';
const preview = Array.from({ length: 35 }, (_line, index) => `line ${index + 1}`).join('\n');
const ctrlO = '\u000F';
const escape = '\u001B';
const down = '\u001B[B';

const layoutQuestion = (options: DialogQuestion['options']): DialogQuestion => ({
  question: 'Which layout?',
  problem,
  impact,
  header: 'Layout',
  multiSelect: false,
  options,
});

const open = (questions: DialogQuestion[], rows = 24, columns = 60, saved?: QuestionnaireState) => {
  const results: DialogResult[] = [];
  const listeners = new Set<(notice: WorkerNoticeEvent) => void>();
  const terminal = { terminal: { rows, columns }, requestRender: vi.fn<() => void>() };

  const saves: QuestionnaireState[] = [];
  const save = (state: QuestionnaireState) => saves.push(state);

  const subscribe = (listener: (notice: WorkerNoticeEvent) => void) => {
    listeners.add(listener);

    return () => listeners.delete(listener);
  };

  const dialog = questionDialog(questions, { saved, subscribe, save })(
    terminal as unknown as TUI,
    theme as unknown as Theme,
    undefined,
    (result) => results.push(result),
  );

  const notify = (notice: WorkerNoticeEvent) => {
    for (const listener of listeners) {
      listener(notice);
    }
  };

  return {
    dialog,
    results,
    saves,
    terminal: terminal.terminal,
    requestRender: terminal.requestRender,
    listeners,
    notify,
  };
};

const tallPreview = (rows = 24, question: Partial<DialogQuestion> = {}) =>
  open(
    [
      {
        ...layoutQuestion([
          { label: 'Stacked', description, preview },
          { label: 'Split', description, preview: 'split' },
          { label: 'Tabs', description, preview: 'tabs' },
        ]),
        ...question,
      },
    ],
    rows,
  );

const longProblem = `Decides the layout. ${'Every panel moves with it. '.repeat(14)}`.slice(0, 397);

it("leaves room for Pi's footer below a tall preview", () => {
  const { dialog } = tallPreview();

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('line 1'))).toBe(true);
  expect(lines.some((line) => line.includes('line 35'))).toBe(false);
});

it('keeps the question and the focused option on screen when the options are too tall', () => {
  const { dialog } = open([
    {
      question: 'Which runtime?',
      problem,
      impact,
      header: 'Runtime',
      multiSelect: false,
      options: ['Node', 'Deno', 'Bun', 'Workers'].map((label) => ({ label, description })),
    },
  ]);

  dialog.handleInput('G');
  dialog.handleInput('\u001B[A');

  const lines = dialog.render(30);

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which runtime?'))).toBe(true);
  expect(lines.some((line) => line.includes('> 4. Workers'))).toBe(true);
});

it('shows the problem and the impact between the question and the options', () => {
  const { dialog } = tallPreview();

  const lines = dialog.render(80);
  const questionRow = lines.findIndex((line) => line.includes('Which layout?'));
  const problemRow = lines.findIndex((line) => line.includes('Decides how the first screen'));
  const impactRow = lines.findIndex((line) => line.includes('blocks the dashboard build'));
  const optionRow = lines.findIndex((line) => line.includes('1. Stacked'));

  expect(questionRow).not.toBe(-1);
  expect(problemRow).not.toBe(-1);
  expect(impactRow).not.toBe(-1);
  expect(optionRow).not.toBe(-1);
  expect(questionRow).toBeLessThan(problemRow);
  expect(problemRow).toBeLessThan(impactRow);
  expect(impactRow).toBeLessThan(optionRow);
});

it('wraps a long problem within the height budget', () => {
  const { dialog } = open([
    {
      ...layoutQuestion(
        ['Stacked', 'Split', 'Tabs', 'Grid'].map((label) => ({ label, description })),
      ),
      problem: `Decides the layout. ${'Every panel moves with it. '.repeat(14)}`,
    },
  ]);

  const lines = dialog.render(40);

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('Decides the layout.'))).toBe(true);
  expect(lines.some((line) => line.includes('> 1. Stacked'))).toBe(true);
});

it('reserves rows for a tall preview and counts the clipped lines', () => {
  const { dialog } = tallPreview();

  const lines = dialog.render(60);
  const shown = lines.filter((line) => /line \d+$/u.test(line)).length;

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Preview: Stacked'))).toBe(true);
  expect(shown).toBeGreaterThan(0);
  expect(lines.some((line) => line.includes(`… ${35 - shown} more lines`))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O full preview'))).toBe(true);
});

it('offers the full preview only when the focused preview is clipped', () => {
  const { dialog } = tallPreview();

  dialog.handleInput(down);

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('Preview: Split'))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O'))).toBe(false);
});

it('offers no full preview for an option without a preview', () => {
  const { dialog } = open([layoutQuestion([{ label: 'Stacked', description }])]);

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('> 1. Stacked'))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O'))).toBe(false);
});

it('shows every description and a badge that stays out of the answer', () => {
  const { dialog, results } = open([
    layoutQuestion([
      { label: 'Stacked', description: 'One column.', recommended: true },
      { label: 'Split', description: 'Two columns.' },
    ]),
  ]);

  const lines = dialog.render(60);

  dialog.handleInput('\r');

  const badgeRow = lines.find((line) => line.includes('Stacked'));

  expect(badgeRow).toContain('★ Recommended');
  expect(lines.some((line) => line.includes('One column.'))).toBe(true);
  expect(lines.some((line) => line.includes('Two columns.'))).toBe(true);

  expect(results).toEqual([
    {
      kind: 'answered',
      answers: [{ question: 'Which layout?', selected: ['Stacked'], typed: false }],
    },
  ]);
});

it('opens the full preview with Ctrl+O and returns to the options with Esc', () => {
  const { dialog, results } = tallPreview();

  dialog.handleInput(ctrlO);

  const full = dialog.render(60);

  dialog.handleInput(down);

  const scrolled = dialog.render(60);

  dialog.handleInput(escape);

  const back = dialog.render(60);

  expect(full.length).toBeLessThanOrEqual(18);
  expect(full.some((line) => line.includes('Preview: Stacked'))).toBe(true);
  expect(full.some((line) => line.endsWith('line 1'))).toBe(true);
  expect(full.some((line) => line.includes('Split'))).toBe(false);
  expect(scrolled.some((line) => line.endsWith('line 1'))).toBe(false);
  expect(scrolled.some((line) => line.endsWith('line 2'))).toBe(true);
  expect(back.some((line) => line.includes('2. Split'))).toBe(true);
  expect(results).toEqual([]);
});

it('closes the full preview with Ctrl+O and cancels with a later Esc', () => {
  const { dialog, results } = tallPreview();

  dialog.handleInput(ctrlO);
  dialog.handleInput(ctrlO);

  const back = dialog.render(60);

  dialog.handleInput(escape);

  expect(back.some((line) => line.includes('2. Split'))).toBe(true);
  expect(results).toEqual([{ kind: 'declined' }]);
});

it('does not type Ctrl+O into the custom row', () => {
  const { dialog, results } = tallPreview();

  dialog.handleInput('G');

  for (const key of ['a', 'b', ctrlO, 'c', '\r']) {
    dialog.handleInput(key);
  }

  expect(results).toEqual([
    { kind: 'answered', answers: [{ question: 'Which layout?', selected: ['abc'], typed: true }] },
  ]);
});

it.each([
  { rule: 'a short terminal', rows: 16, width: 60, question: {} },
  { rule: 'a long problem', rows: 24, width: 40, question: { problem: longProblem } },
])('keeps the clipped preview and its hint on $rule', ({ rows, width, question }) => {
  const { dialog } = tallPreview(rows, question);

  const lines = dialog.render(width);

  expect(lines.length).toBeLessThanOrEqual(rows - 6);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('> 1. Stacked'))).toBe(true);
  expect(lines.some((line) => line.includes('Preview: Stacked'))).toBe(true);
  expect(lines.some((line) => line.includes('more lines'))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O'))).toBe(true);
});

it('offers the full preview when no preview row fits', () => {
  const { dialog } = tallPreview(10);

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(4);
  expect(lines.some((line) => line.includes('Preview: Stacked'))).toBe(false);
  expect(lines.some((line) => line.includes('Ctrl+O full preview'))).toBe(true);
});

it('fits both views into a terminal under 14 rows', () => {
  const { dialog } = tallPreview(13);

  const options = dialog.render(60);

  dialog.handleInput(ctrlO);

  const full = dialog.render(60);

  expect(options.length).toBeLessThanOrEqual(7);
  expect(options.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(options.some((line) => line.includes('> 1. Stacked'))).toBe(true);
  expect(options.some((line) => line.includes('Decides how'))).toBe(true);
  expect(options.some((line) => line.includes('Ctrl+O full preview'))).toBe(true);
  expect(full.length).toBeLessThanOrEqual(7);
  expect(full.some((line) => line.endsWith('line 1'))).toBe(true);
  expect(full.some((line) => line.includes('Esc back'))).toBe(true);
});

it('keeps the question, problem, and impact over wrapped tabs', () => {
  const storage = {
    ...layoutQuestion([
      { label: 'Project', description },
      { label: 'Home', description },
    ]),
    question: 'Where should the cache live?',
    header: 'Storage location',
  };

  const { dialog } = open(
    [
      {
        ...layoutQuestion([
          { label: 'Stacked', description: 'One column.', preview },
          { label: 'Split', description, preview: 'split' },
        ]),
        header: 'Dashboard layout',
      },
      storage,
    ],
    18,
  );

  const lines = dialog.render(40);

  expect(lines.length).toBeLessThanOrEqual(12);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('Decides how the first'))).toBe(true);
  expect(lines.some((line) => line.includes('> 1. Stacked'))).toBe(true);
  expect(lines.some((line) => line.includes('Preview: Stacked'))).toBe(true);
});

it('fits the full preview into a 9-row terminal', () => {
  const { dialog } = tallPreview(9);

  dialog.handleInput(ctrlO);

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(3);
  expect(lines.some((line) => line.includes('Preview: Stacked'))).toBe(true);
  expect(lines.some((line) => line.endsWith('line 1'))).toBe(true);
  expect(lines.some((line) => line.includes('Esc back'))).toBe(true);
});

const cache = (label: string, cost: string) => ({
  label,
  description: `Stores cached config in the ${label.toLowerCase()} so the files stay easy to inspect and debug for every clone. ${cost}`,
  preview: `${label}/config.json`,
});

it('clips the problem instead of the focused description', () => {
  const { dialog } = open([
    {
      ...layoutQuestion([
        cache('Project folder', 'The cost is that secrets can be committed.'),
        cache('Home folder', 'The cost is that other programs can read secrets.'),
      ]),
      problem: `Startup reads configuration before it shows the dashboard. ${'This choice decides who can clear cached files and who can read them. '.repeat(4)}`,
    },
  ]);

  const first = dialog.render(60);

  dialog.handleInput(down);

  const second = dialog.render(60);

  expect(first.length).toBeLessThanOrEqual(18);
  expect(first.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(first.some((line) => line.includes('Startup reads configuration'))).toBe(true);
  expect(first.some((line) => line.includes('secrets can be committed.'))).toBe(true);
  expect(first.some((line) => line.includes('Preview: Project folder'))).toBe(true);
  expect(second.length).toBeLessThanOrEqual(18);
  expect(second.some((line) => line.includes('programs can read secrets.'))).toBe(true);
  expect(second.some((line) => line.includes('Preview: Home folder'))).toBe(true);
});

it('hides the compact preview before it clips a focused description that fits', () => {
  const { dialog } = open(
    [
      layoutQuestion([
        cache(
          'Project folder',
          'It never reads stale values. The cost is that secrets can be committed.',
        ),
        cache('Home folder', 'The cost is that other programs can read secrets.'),
      ]),
    ],
    16,
    40,
  );

  const lines = dialog.render(40);

  expect(lines.length).toBeLessThanOrEqual(10);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('committed.'))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O full preview'))).toBe(true);
});

const command = (index: number) =>
  `find .cache/${index} -type f -name cached-configuration-for-dashboard.json -delete`;

const widePreview = (columns = 60) =>
  open(
    [
      layoutQuestion([
        {
          label: 'Clean',
          description: 'Removes cached files.',
          preview: Array.from({ length: 20 }, (_line, index) => command(index + 1)).join('\n'),
        },
        { label: 'Keep', description: 'Leaves cached files.', preview: command(0) },
      ]),
    ],
    24,
    columns,
  );

it('offers the full preview when a preview line is wider than the dialog', () => {
  const { dialog } = widePreview();

  dialog.handleInput(down);

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('Preview: Keep'))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O full preview'))).toBe(true);
});

it('wraps wide lines in the full preview and scrolls by wrapped rows', () => {
  const { dialog } = widePreview();

  dialog.handleInput(ctrlO);

  const top = dialog.render(60);

  dialog.handleInput('G');

  const bottom = dialog.render(60);
  const rows = top.filter((line) => line.startsWith(' │ ') && !line.includes('more lines'));

  expect(top.length).toBeLessThanOrEqual(18);
  expect(rows.every((line) => line.length <= 60)).toBe(true);
  expect(top.some((line) => line.endsWith('-delete'))).toBe(true);
  expect(top.some((line) => line.includes(`… ${40 - rows.length} more lines`))).toBe(true);
  expect(top.some((line) => line.includes('↑↓ scroll'))).toBe(true);
  expect(bottom.length).toBeLessThanOrEqual(18);
  expect(bottom.some((line) => line.includes('find .cache/20 '))).toBe(true);
  expect(bottom.at(-4)).toMatch(/-delete$/u);
});

it('shows the full preview hint first on a narrow multi-select dialog', () => {
  const { dialog } = tallPreview(16, { multiSelect: true });

  const lines = dialog.render(40);

  expect(lines.some((line) => line.includes('more lines'))).toBe(true);
  expect(lines.some((line) => line.includes('Ctrl+O full preview'))).toBe(true);
});

it.each([
  { rule: 'before the first render', firstWidth: undefined },
  { rule: 'after a resize before the next render', firstWidth: 100 },
])('scrolls the full preview to its last wrapped row $rule', ({ firstWidth }) => {
  const { dialog, terminal } = widePreview(firstWidth ?? 60);

  dialog.handleInput(ctrlO);

  if (firstWidth !== undefined) {
    dialog.render(firstWidth);
    terminal.columns = 60;
  }

  dialog.handleInput('G');

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('find .cache/20 '))).toBe(true);
  expect(lines.some((line) => line.includes('more lines'))).toBe(false);
});

it('drops the header border before the problem, description, or preview', () => {
  const { dialog } = open(
    [
      layoutQuestion([
        cache(
          'Project folder',
          'It never reads stale values from another clone. The cost is that secrets can be committed.',
        ),
        cache('Home folder', 'The cost is that other programs can read secrets.'),
      ]),
    ],
    24,
    30,
  );

  const lines = dialog.render(30);

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('Decides how the first'))).toBe(true);
  expect(lines.some((line) => line.includes('committed.'))).toBe(true);
  expect(lines.some((line) => line.includes('Preview: Project folder'))).toBe(true);
});

it.each([
  { view: 'the option list', keys: [] },
  { view: 'the full preview', keys: [ctrlO] },
])('keeps the hidden-line count within a narrow width in $view', ({ keys }) => {
  const { dialog } = open(
    [
      layoutQuestion([
        { label: 'Stacked', description: 'One.', preview },
        { label: 'Split', description: 'Two.', preview: 'split' },
      ]),
    ],
    24,
    12,
  );

  for (const key of keys) {
    dialog.handleInput(key);
  }

  const lines = dialog.render(12);

  expect(lines.some((line) => line.includes('…'))).toBe(true);
  expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
});

it('keeps a problem row when a long focused description fills a short terminal', () => {
  const { dialog } = open(
    [
      layoutQuestion([
        {
          ...cache(
            'Project folder',
            'It never reads stale values from another clone. The cost is that secrets can be committed.',
          ),
          recommended: true,
        },
        cache('Home folder', 'The cost is that other programs can read secrets.'),
      ]),
    ],
    18,
    40,
  );

  const lines = dialog.render(40);

  expect(lines.length).toBeLessThanOrEqual(12);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('Decides how'))).toBe(true);
});

const scout: WorkerNoticeEvent = { worker: 'scout-ov', label: 'reported success · stopped' };

const twoOptions = (multiSelect = false) => ({
  ...layoutQuestion([
    { label: 'Stacked', description: 'One column.' },
    { label: 'Split', description: 'Two columns.' },
  ]),
  multiSelect,
});

const actionText = actionLabel([scout]);

it('shows a notice line and the action row only after a notice arrives', () => {
  const { dialog, notify, requestRender } = open([twoOptions()]);

  const before = dialog.render(80).join('\n');

  notify(scout);

  const after = dialog.render(80).join('\n');

  expect(before).not.toContain('scout-ov');
  expect(after).toContain('scout-ov · reported success · stopped');
  expect(after).toContain(actionText);
  expect(requestRender).toHaveBeenCalled();
});

it('puts the action row below the custom row after a blank line', () => {
  const { dialog, notify } = open([twoOptions()]);

  notify(scout);

  const lines = dialog.render(80);
  const custom = lines.findIndex((line) => line.includes('3. '));
  const action = lines.findIndex((line) => line.includes(actionText));

  expect(action).toBeGreaterThan(custom);
  expect(lines[action - 1]?.trim()).toBe('');
});

it('defers with the notices and the state when Enter hits the action row', () => {
  const { dialog, notify, results } = open([twoOptions()]);

  notify(scout);

  for (const key of [down, down, down, '\r']) {
    dialog.handleInput(key);
  }

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ kind: 'deferred', notices: [scout] });
});

it('does not reach the action row before a notice arrives', () => {
  const { dialog, results } = open([twoOptions()]);

  for (const key of [down, down, down, down]) {
    dialog.handleInput(key);
  }

  dialog.handleInput('x');
  dialog.handleInput('\r');

  expect(results).toEqual([
    { kind: 'answered', answers: [{ question: 'Which layout?', selected: ['x'], typed: true }] },
  ]);
});

it('keeps checked options unchanged when Space hits the action row in multi-select', () => {
  const { dialog, notify, results, saves } = open([twoOptions(true)]);

  notify(scout);
  dialog.handleInput(' ');

  for (const key of [down, down, down, ' ', '\r']) {
    dialog.handleInput(key);
  }

  expect(results).toMatchObject([{ kind: 'deferred' }]);
  expect(saves).toMatchObject([{ questions: [{ checked: [0] }] }]);
});

it('declines with Esc after a notice arrived', () => {
  const { dialog, notify, results } = open([twoOptions()]);

  notify(scout);
  dialog.handleInput(escape);

  expect(results).toEqual([{ kind: 'declined' }]);
});

it('stops listening once the dialog closes', () => {
  const { dialog, listeners, results } = open([twoOptions()]);

  expect(listeners.size).toBe(1);

  dialog.handleInput(escape);

  expect(results).toHaveLength(1);
  expect(listeners.size).toBe(0);
});

it('starts from the saved state with the typed text in the custom row', () => {
  const first = open([twoOptions()]);

  first.notify(scout);

  for (const key of [down, down, 'a', 'b', down, '\r']) {
    first.dialog.handleInput(key);
  }

  const [saved] = first.saves;

  const second = open([twoOptions()], 24, 60, saved);
  const focused = second.dialog.render(80).join('\n');

  second.dialog.handleInput('\u001B[A');

  const lines = second.dialog.render(80).join('\n');

  second.dialog.handleInput(down);
  second.dialog.handleInput('\r');

  expect(lines).toContain('3. ab');
  expect(focused).not.toContain(actionText);

  expect(second.results).toEqual([
    { kind: 'answered', answers: [{ question: 'Which layout?', selected: ['ab'], typed: true }] },
  ]);
});

const workers = (count: number) =>
  Array.from({ length: count }, (_item, index) => ({
    worker: `worker-${index + 1}`,
    label: 'asks',
  }));

it.each([10, 12, 14, 24])('keeps three notices within the row budget at %i rows', (rows) => {
  const { dialog, notify } = open([twoOptions()], rows);

  for (const notice of workers(3)) {
    notify(notice);
  }

  const budget = rows - 6;
  const onOption = dialog.render(80);

  for (const key of [down, down, down]) {
    dialog.handleInput(key);
  }

  const onAction = dialog.render(80);

  expect(onOption.length).toBeLessThanOrEqual(budget);
  expect(onAction.length).toBeLessThanOrEqual(budget);
  expect(onAction.some((line) => line.includes(`> ${actionLabel(workers(3))}`))).toBe(true);
});

it('shows waiting notices when no notice line fits', () => {
  const { dialog, notify } = open([twoOptions()], 10);

  const before = dialog.render(80);

  for (const notice of workers(4)) {
    notify(notice);
  }

  const after = dialog.render(80);

  expect(after).not.toEqual(before);
  expect(after.length).toBeLessThanOrEqual(4);
});

it('shows a notice during the full preview within its row budget', () => {
  const { dialog, notify } = tallPreview();

  dialog.handleInput(ctrlO);
  notify(scout);

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('scout-ov'))).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(18);
});

it('replaces the line of a worker that notifies again', () => {
  const { dialog, notify } = open([twoOptions()]);

  notify({ worker: 'scout-ov', label: 'asks' });
  notify({ worker: 'scout-ov', label: 'reported success · stopped' });

  const text = dialog.render(80).join('\n');

  expect(text).toContain('scout-ov · reported success · stopped');
  expect(text).not.toContain('scout-ov · asks');
});

it('counts the workers whose lines do not fit', () => {
  const { dialog, notify } = open([twoOptions()], 14);

  for (const notice of workers(6)) {
    notify(notice);
  }

  const text = dialog.render(80).join('\n');
  const shown = workers(6).filter((notice) => text.includes(`${notice.worker} ·`));

  expect(shown.length).toBeGreaterThan(0);
  expect(text).toContain(`+${6 - shown.length} more`);
});

const draft = 'Subject: Release notes\nBody: Ship it.';

const withDraft = (options: DialogQuestion['options']): DialogQuestion => ({
  ...layoutQuestion(options),
  preview: draft,
});

it('shows the question preview on options without one and lets an own preview replace it', () => {
  const { dialog } = open([
    withDraft([
      { label: 'Stacked', description },
      { label: 'Split', description, preview: 'split' },
    ]),
  ]);

  const shared = dialog.render(60).join('\n');

  dialog.handleInput(down);

  const own = dialog.render(60).join('\n');

  expect(shared).toContain('Body: Ship it.');
  expect(own).toContain('split');
  expect(own).not.toContain('Body: Ship it.');
});

it('opens the full preview of the question and of the focused option', () => {
  const { dialog } = open([
    withDraft([
      { label: 'Stacked', description },
      { label: 'Split', description, preview: 'split' },
    ]),
  ]);

  dialog.handleInput(ctrlO);

  const shared = dialog.render(60).join('\n');

  dialog.handleInput(ctrlO);
  dialog.handleInput(down);
  dialog.handleInput(ctrlO);

  const own = dialog.render(60).join('\n');

  expect(shared).toContain('Body: Ship it.');
  expect(shared).not.toContain('Preview: Stacked');
  expect(own).toContain('Preview: Split');
  expect(own).not.toContain('Body: Ship it.');
});

it('shows no question preview on the custom row', () => {
  const { dialog } = open([withDraft([{ label: 'Stacked', description }])]);

  dialog.handleInput(down);

  expect(dialog.render(60).join('\n')).not.toContain('Body: Ship it.');
});

it('opens on the recommended option and answers it with Enter', () => {
  const { dialog, results } = open([
    layoutQuestion([
      { label: 'Stacked', description },
      { label: 'Split', description, recommended: true },
    ]),
  ]);

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('> 2. Split'))).toBe(true);
  expect(results).toEqual([]);

  dialog.handleInput('\r');

  expect(results).toEqual([
    {
      kind: 'answered',
      answers: [{ question: 'Which layout?', selected: ['Split'], typed: false }],
    },
  ]);
});

it.each([9, 10])('keeps the question within the available rows at %i rows', (rows) => {
  const { dialog } = open(
    [
      layoutQuestion([
        { label: 'Stacked', description: 'One.', preview: 'one' },
        { label: 'Split', description: 'Two.', recommended: true, preview: 'two' },
      ]),
    ],
    rows,
  );

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(rows - 6);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('> 2. Split'))).toBe(true);
});

it('drops the impact before the problem when rows run short', () => {
  const { dialog } = open([twoOptions()], 11);

  const lines = dialog.render(60).join('\n');

  expect(lines).toContain('Which layout?');
  expect(lines).toContain('Decides how the first screen');
  expect(lines).not.toContain('blocks the dashboard build');
});

const tabKey = '\t';
const shiftTab = '\u001B[Z';
const home = '\u001B[H';

const threeQuestions = ['First?', 'Second?', 'Third?'].map((question, index) =>
  Object.assign(twoOptions(), { question, header: `Tab${index + 1}` }),
);

const shows = (dialog: { render: (width: number) => string[] }, text: string) =>
  dialog.render(80).some((line) => line.includes(text));

it.each([
  { rule: 'Tab goes to the next question', keys: [tabKey], shown: 'Second?' },
  { rule: 'Shift+Tab goes to the previous question', keys: [shiftTab], shown: 'Third?' },
  { rule: 'Tab on the custom row switches question', keys: [down, down, tabKey], shown: 'Second?' },
  {
    rule: 'Shift+Tab on the custom row switches question',
    keys: [down, down, shiftTab],
    shown: 'Third?',
  },
])('$rule', ({ keys, shown }) => {
  const { dialog } = open(threeQuestions);

  for (const key of keys) {
    dialog.handleInput(key);
  }

  expect(shows(dialog, shown)).toBe(true);
  expect(shows(dialog, 'First?')).toBe(false);
});

it('does not type Tab into the custom row', () => {
  const { dialog, results } = open([twoOptions()]);

  for (const key of [down, down, tabKey, shiftTab, 'a', '\r']) {
    dialog.handleInput(key);
  }

  expect(results).toEqual([
    { kind: 'answered', answers: [{ question: 'Which layout?', selected: ['a'], typed: true }] },
  ]);
});

const rowOf = (dialog: { render: (width: number) => string[] }, text: string, width = 80) =>
  dialog.render(width).find((line) => line.includes(text));

it('moves the cursor to the first row with Home and ignores unbound keys', () => {
  const { dialog } = open([twoOptions()]);
  const initial = rowOf(dialog, 'Stacked');

  dialog.handleInput(down);

  expect(rowOf(dialog, 'Stacked')).not.toBe(initial);

  dialog.handleInput(home);

  expect(rowOf(dialog, 'Stacked')).toBe(initial);

  dialog.handleInput('\u001B[1;5P');

  expect(rowOf(dialog, 'Stacked')).toBe(initial);
});

it('focuses one row at a time', () => {
  const { dialog } = open([twoOptions()]);
  const before = ['Stacked', 'Split', 'Type something'].map((label) => rowOf(dialog, label));

  dialog.handleInput(down);

  const after = ['Stacked', 'Split', 'Type something'].map((label) => rowOf(dialog, label));

  expect(after.map((row, index) => row !== before[index])).toEqual([true, true, false]);
});

it('checks only the options the user checked', () => {
  const { dialog } = open([twoOptions(true)]);
  const before = [rowOf(dialog, 'Stacked'), rowOf(dialog, 'Split')];

  dialog.handleInput(' ');

  expect(rowOf(dialog, 'Stacked')).not.toBe(before[0]);
  expect(rowOf(dialog, 'Split')).toBe(before[1]);

  dialog.handleInput(' ');

  expect(rowOf(dialog, 'Stacked')).toBe(before[0]);
});

it('focuses the action row only when the cursor is on it', () => {
  const { dialog, notify } = open([twoOptions()]);

  notify(scout);

  const unfocused = rowOf(dialog, actionText);

  dialog.handleInput(down);
  dialog.handleInput(down);

  expect(rowOf(dialog, actionText)).toBe(unfocused);

  dialog.handleInput(down);

  expect(rowOf(dialog, actionText)).not.toBe(unfocused);
});

it('adds the action row only when a notice arrives', () => {
  const { dialog, notify } = open([twoOptions()]);
  const before = dialog.render(80);

  notify(scout);

  const after = dialog.render(80);

  expect(after.length).toBeGreaterThan(before.length);
  expect(after).toEqual(expect.arrayContaining(before));
});

const firstMark = (line: string) => line.slice(0, line.indexOf('Tab1'));
const secondMark = (line: string) => line.slice(line.indexOf('Tab1'), line.indexOf('Tab2'));

it('marks answered questions in the tab bar of a multi-question dialog', () => {
  const { dialog } = open(threeQuestions.slice(0, 2));
  const tabLine = () => rowOf(dialog, 'Tab1') ?? '';
  const before = tabLine();

  expect(before).toContain('Tab2');

  dialog.handleInput('\r');

  const after = tabLine();

  expect(firstMark(after)).not.toBe(firstMark(before));
  expect(secondMark(after)).toBe(secondMark(before));
});

it('shows no tab bar for a single question', () => {
  const { dialog } = open([twoOptions()]);

  expect(shows(dialog, 'Layout')).toBe(false);
});

it('shows the text the user types on the custom row', () => {
  const { dialog } = open([twoOptions()]);

  for (const key of [down, down, 'h', 'e', 'l', 'l', 'o']) {
    dialog.handleInput(key);
  }

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('hello'))).toBe(true);
  expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(60);
});

it('stops showing worker notices once Pi disposes the dialog', () => {
  const { dialog, notify } = open([twoOptions()]);

  dialog.dispose();
  notify(scout);

  const text = dialog.render(80).join('\n');

  expect(text).not.toContain('scout-ov');
  expect(text).not.toContain(actionText);
});

const previewLines = (count: number) =>
  Array.from({ length: count }, (_line, index) => `row-${index + 1}`).join('\n');

const rowCounts = Array.from({ length: 20 }, (_item, index) => index + 9);

it.each(rowCounts)('keeps every view within the available rows at %i rows', (rows) => {
  const questions = [
    {
      ...layoutQuestion([
        { label: 'Stacked', description, preview: previewLines(30) },
        { label: 'Split', description, preview: 'wide '.repeat(30) },
      ]),
      problem: longProblem,
    },
    twoOptions(true),
  ];

  const { dialog, notify } = open(questions, rows, 40);

  notify(scout);

  const budget = rows - 6;
  const heights: number[] = [];

  for (const key of ['', down, down, down, ctrlO, ctrlO, tabKey]) {
    if (key !== '') {
      dialog.handleInput(key);
    }

    heights.push(dialog.render(40).length);
  }

  expect(Math.max(...heights)).toBeLessThanOrEqual(budget);
});

const previewFixture = (rows: number, lineCount = 8) =>
  open(
    [
      layoutQuestion([
        { label: 'Stacked', description: 'Short.', preview: previewLines(lineCount) },
        { label: 'Split', description: 'Short.' },
      ]),
    ],
    rows,
    60,
  );

const previewRowsIn = (lines: string[]) => lines.filter((line) => /row-\d+$/u.test(line));

// Scrolls the full preview from top to bottom and collects every fixture line it ever shows.
const reachablePreviewLines = (dialog: ReturnType<typeof open>['dialog']) => {
  const seen = new Set<string>();

  dialog.handleInput(ctrlO);

  for (let step = 0; step < 60; step += 1) {
    for (const line of previewRowsIn(dialog.render(60))) {
      seen.add(line.slice(line.lastIndexOf('row-')));
    }

    dialog.handleInput(down);
  }

  return seen;
};

it('shows every preview line in a roomy terminal', () => {
  const { dialog } = previewFixture(40);

  expect(previewRowsIn(dialog.render(60))).toHaveLength(8);
});

// The hidden-line count is found as a number followed by "more", the only wording this test needs.
const hiddenCountIn = (lines: string[]) => {
  const counts = lines.flatMap((line) => [...line.matchAll(/(\d+) more/gu)].map((m) => m[1]));

  return counts.length === 0 ? undefined : Number(counts.at(-1));
};

it.each(rowCounts)('keeps every preview line reachable at %i rows', (rows) => {
  const { dialog } = previewFixture(rows);
  const lines = dialog.render(60);
  const shown = previewRowsIn(lines).length;
  const hidden = hiddenCountIn(lines);

  expect(hidden === undefined ? shown === 0 || shown === 8 : hidden === 8 - shown).toBe(true);
  expect(shown === 8 ? hidden : undefined).toBeUndefined();
  expect(lines.some((line) => line.includes('Ctrl+O')) || shown === 8).toBe(true);
  expect(reachablePreviewLines(dialog).size).toBe(8);
});

it('shows no hidden-line count when the whole preview fits', () => {
  const lines = previewFixture(40).dialog.render(60);

  expect(hiddenCountIn(lines)).toBeUndefined();
});

it('offers the full preview only for a line wider than the preview area', () => {
  const offers = (candidate: string) =>
    open(
      [
        layoutQuestion([
          { label: 'Stacked', description: 'Short.', preview: candidate },
          { label: 'Split', description: 'Short.' },
        ]),
      ],
      40,
      60,
    )
      .dialog.render(60)
      .some((line) => line.includes('Ctrl+O'));

  const probe = open(
    [
      layoutQuestion([
        { label: 'Stacked', description: 'Short.', preview: 'x' },
        { label: 'Split', description: 'Short.' },
      ]),
    ],
    40,
    60,
  ).dialog.render(60);

  const barWidth = visibleWidth(probe.find((line) => line.trimEnd().endsWith('x')) ?? '') - 1;
  const area = 60 - barWidth;

  expect(offers('x'.repeat(area))).toBe(false);
  expect(offers('x'.repeat(area + 1))).toBe(true);
});

it('keeps every token of a very wide preview line reachable', () => {
  const tokens = Array.from({ length: 40 }, (_item, index) => `tok${index}`);

  const { dialog } = open(
    [
      layoutQuestion([
        { label: 'Stacked', description: 'Short.', preview: `short\n${tokens.join(' ')}\nshort` },
        { label: 'Split', description: 'Short.' },
      ]),
    ],
    40,
    60,
  );

  const optionLines = dialog.render(60);

  expect(Math.max(...optionLines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(60);
  expect(tokens.every((token) => optionLines.join('\n').includes(token))).toBe(false);
  expect(optionLines.some((line) => line.includes('Ctrl+O'))).toBe(true);

  dialog.handleInput(ctrlO);

  const seen = new Set<string>();

  for (let step = 0; step < 30; step += 1) {
    for (const token of tokens) {
      if (
        dialog.render(60).join('\n').includes(`${token} `) ||
        dialog.render(60).join('\n').includes(`${token}\n`)
      ) {
        seen.add(token);
      }
    }

    dialog.handleInput(down);
  }

  expect(seen.size).toBe(tokens.length);
});

it.each(rowCounts)('shows the typed custom text with a tall preview at %i rows', (rows) => {
  const { dialog } = previewFixture(rows, 30);

  for (const key of [down, down, 'z', 'z', 'z']) {
    dialog.handleInput(key);
  }

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('zzz'))).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(rows - 6);
});

it('keeps the preview beside a clipped long description once the preview fits', () => {
  const clippedHeights = rowCounts.flatMap((rows) => {
    const { dialog } = open(
      [
        layoutQuestion([
          { label: 'Stacked', description: 'word '.repeat(30), preview: previewLines(6) },
          { label: 'Split', description: 'Short.' },
        ]),
      ],
      rows,
      20,
    );

    const lines = dialog.render(20);

    expect(lines.length).toBeLessThanOrEqual(rows - 6);
    expect(lines.some((line) => line.includes('Stacked'))).toBe(true);

    // The description fills 10 rows when nothing clips it.
    const clipped = lines.filter((line) => line.includes('word')).length < 10;
    const hasPreview = hiddenCountIn(lines) !== undefined || previewRowsIn(lines).length === 6;

    return clipped ? [hasPreview] : [];
  });

  const first = clippedHeights.indexOf(true);

  expect(first).toBeGreaterThanOrEqual(0);
  expect(clippedHeights.slice(first).every(Boolean)).toBe(true);
});

const wrapped = (prefix: string) =>
  [1, 2, 3].map((index) => `${prefix}${index}${'x'.repeat(21)}`).join(' ');

it.each(rowCounts)('clips header text only when it does not fit at %i rows', (rows) => {
  const make = (height: number) =>
    open(
      [{ ...twoOptions(), question: wrapped('Q'), problem: wrapped('P'), impact: wrapped('I') }],
      height,
      30,
    ).dialog.render(30);

  const roomy = make(60);
  const lines = make(rows);

  expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(30);
  expect(lines.length).toBeLessThanOrEqual(rows - 6);

  for (const prefix of ['Q', 'P', 'I']) {
    const pattern = new RegExp(`${prefix}\\d+x+`, 'u');
    const full = roomy.filter((line) => pattern.test(line));
    const shown = lines.filter((line) => pattern.test(line));

    expect(full).toHaveLength(3);
    expect(shown.slice(0, -1)).toEqual(full.slice(0, Math.max(0, shown.length - 1)));

    const last = shown.at(-1);
    const unchanged = last === full[shown.length - 1];

    expect(last === undefined || unchanged === (shown.length === 3)).toBe(true);
  }

  expect(lines.some((line) => /Q\d+x+/u.test(line))).toBe(true);
});

it('gives a question without a preview more header rows than one with a preview', () => {
  const headerRows = (sketch: string | undefined, rows: number) => {
    const { dialog } = open(
      [
        {
          ...layoutQuestion([
            {
              label: 'Stacked',
              description: 'One.',
              ...(sketch === undefined ? {} : { preview: sketch }),
            },
            { label: 'Split', description: 'Two.' },
          ]),
          problem: wrapped('P'),
          impact: wrapped('I'),
        },
      ],
      rows,
      30,
    );

    return dialog.render(30).filter((line) => /[PI]\d+x+/u.test(line)).length;
  };

  const without = rowCounts.map((rows) => headerRows(undefined, rows));
  const withPreview = rowCounts.map((rows) => headerRows('sketch', rows));

  expect(without.every((count, index) => count >= (withPreview[index] ?? 0))).toBe(true);
  expect(without.some((count, index) => count > (withPreview[index] ?? 0))).toBe(true);
});

it.each(rowCounts)(
  'fits the full preview and a notice into the available rows at %i rows',
  (rows) => {
    const { dialog, notify } = tallPreview(rows);

    notify(scout);
    dialog.handleInput(ctrlO);

    expect(dialog.render(60).length).toBeLessThanOrEqual(rows - 6);
  },
);

it('fills the last page of the full preview after the terminal grows', () => {
  const { dialog, terminal } = tallPreview(12);
  const previewRows = () => dialog.render(60).filter((line) => /line \d+$/u.test(line)).length;

  dialog.handleInput(ctrlO);

  for (let press = 0; press < 40; press += 1) {
    dialog.handleInput(down);
  }

  terminal.rows = 30;

  const fresh = tallPreview(30);

  fresh.dialog.handleInput(ctrlO);

  const freshRows = fresh.dialog.render(60).filter((line) => /line \d+$/u.test(line)).length;

  expect(previewRows()).toBe(freshRows);
  expect(dialog.render(60).some((line) => line.endsWith('line 35'))).toBe(true);
});

it('keeps the custom row once it is visible as the terminal grows', () => {
  const visibleAt = rowCounts.map((rows) => {
    const lines = previewFixture(rows).dialog.render(60);

    expect(lines.length).toBeLessThanOrEqual(rows - 6);

    return lines.some((line) => line.includes('Type something'));
  });

  const first = visibleAt.indexOf(true);

  expect(first).toBeGreaterThanOrEqual(0);
  expect(visibleAt.slice(first).every(Boolean)).toBe(true);
});
