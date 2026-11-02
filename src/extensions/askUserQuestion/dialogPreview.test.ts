import { visibleWidth } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import type { DialogQuestion } from './dialog.js';
import {
  cache,
  ctrlO,
  description,
  down,
  escape,
  layoutQuestion,
  longProblem,
  open,
  preview,
  previewFixture,
  previewLines,
  rowCounts,
  tallPreview,
} from './fixtures/dialogHarness.js';

it("leaves room for Pi's footer below a tall preview", () => {
  const { dialog } = tallPreview();

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(18);
  expect(lines.some((line) => line.includes('Which layout?'))).toBe(true);
  expect(lines.some((line) => line.includes('line 1'))).toBe(true);
  expect(lines.some((line) => line.includes('line 35'))).toBe(false);
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

it('fits the full preview into a 9-row terminal', () => {
  const { dialog } = tallPreview(9);

  dialog.handleInput(ctrlO);

  const lines = dialog.render(60);

  expect(lines.length).toBeLessThanOrEqual(3);
  expect(lines.some((line) => line.includes('Preview: Stacked'))).toBe(true);
  expect(lines.some((line) => line.endsWith('line 1'))).toBe(true);
  expect(lines.some((line) => line.includes('Esc back'))).toBe(true);
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

const offersFullPreview = (candidate: string) =>
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

it('offers the full preview only for a line wider than the preview area', () => {
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

  expect(offersFullPreview('x'.repeat(area))).toBe(false);
  expect(offersFullPreview('x'.repeat(area + 1))).toBe(true);
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
