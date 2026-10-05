import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import { questionDialog } from './dialog.js';
import type { DialogQuestion, DialogResult } from './dialog.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const context = 'Decides how the first screen looks. Changing it later moves every panel.';
const description = 'A long description that wraps over several lines on a narrow terminal.';
const preview = Array.from({ length: 35 }, (_line, index) => `line ${index + 1}`).join('\n');
const ctrlO = '\u000F';
const escape = '\u001B';
const down = '\u001B[B';

const layoutQuestion = (options: DialogQuestion['options']): DialogQuestion => ({
  question: 'Which layout?',
  context,
  header: 'Layout',
  multiSelect: false,
  options,
});

const open = (questions: DialogQuestion[], rows = 24, columns = 60) => {
  const results: DialogResult[] = [];
  const terminal = { terminal: { rows, columns }, requestRender: () => undefined };

  const dialog = questionDialog(questions)(
    terminal as unknown as TUI,
    theme as unknown as Theme,
    undefined,
    (result) => results.push(result),
  );

  return { dialog, results, terminal: terminal.terminal };
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

const longContext = `Decides the layout. ${'Every panel moves with it. '.repeat(14)}`.slice(0, 397);

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
      context,
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

it('shows the context between the question and the options', () => {
  const { dialog } = tallPreview();

  const lines = dialog.render(80);
  const questionRow = lines.findIndex((line) => line.includes('Which layout?'));
  const contextRow = lines.findIndex((line) => line.includes('Decides how the first screen'));
  const optionRow = lines.findIndex((line) => line.includes('1. Stacked'));

  expect(questionRow).not.toBe(-1);
  expect(contextRow).not.toBe(-1);
  expect(optionRow).not.toBe(-1);
  expect(questionRow).toBeLessThan(contextRow);
  expect(contextRow).toBeLessThan(optionRow);
});

it('wraps a long context within the height budget', () => {
  const { dialog } = open([
    {
      ...layoutQuestion(
        ['Stacked', 'Split', 'Tabs', 'Grid'].map((label) => ({ label, description })),
      ),
      context: `Decides the layout. ${'Every panel moves with it. '.repeat(14)}`,
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
  expect(shown).toBeGreaterThan(1);
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
    { cancelled: false, answers: [{ question: 'Which layout?', selected: ['Stacked'] }] },
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
  expect(results).toEqual([{ cancelled: true, answers: [] }]);
});

it('does not type Ctrl+O into the custom row', () => {
  const { dialog, results } = tallPreview();

  dialog.handleInput('G');

  for (const key of ['a', 'b', ctrlO, 'c', '\r']) {
    dialog.handleInput(key);
  }

  expect(results).toEqual([
    { cancelled: false, answers: [{ question: 'Which layout?', selected: ['abc'] }] },
  ]);
});

it.each([
  { rule: 'a short terminal', rows: 16, width: 60, question: {} },
  { rule: 'a long context', rows: 24, width: 40, question: { context: longContext } },
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
  expect(options.some((line) => line.includes('Preview: Stacked'))).toBe(true);
  expect(full.length).toBeLessThanOrEqual(7);
  expect(full.some((line) => line.endsWith('line 1'))).toBe(true);
  expect(full.some((line) => line.includes('Esc back'))).toBe(true);
});

it('keeps the question and context over wrapped tabs', () => {
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

it('clips the context instead of the focused description', () => {
  const { dialog } = open([
    {
      ...layoutQuestion([
        cache('Project folder', 'The cost is that secrets can be committed.'),
        cache('Home folder', 'The cost is that other programs can read secrets.'),
      ]),
      context: `Startup reads configuration before it shows the dashboard. ${'This choice decides who can clear cached files and who can read them. '.repeat(4)}`,
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
