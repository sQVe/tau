import { visibleWidth } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import {
  cache,
  ctrlO,
  description,
  down,
  impact,
  layoutQuestion,
  longProblem,
  open,
  preview,
  previewFixture,
  previewLines,
  problem,
  rowCounts,
  tallPreview,
} from './fixtures/dialogHarness.js';

it('keeps the question and the focused option on screen when the options are too tall', () => {
  const { dialog } = open([
    {
      question: 'Which runtime?',
      problem,
      impact,
      header: 'Runtime',
      multiSelect: false,
      options: ['Node', 'Deno', 'Bun', 'Workers'].map((label) => ({
        label,
        description,
      })),
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
        ['Stacked', 'Split', 'Tabs', 'Grid'].map((label) => ({
          label,
          description,
        })),
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

it('does not type Ctrl+O into the custom row', () => {
  const { dialog, results } = tallPreview();

  dialog.handleInput('G');

  for (const key of ['a', 'b', ctrlO, 'c', '\r']) {
    dialog.handleInput(key);
  }

  expect(results).toEqual([
    {
      kind: 'answered',
      answers: [{ question: 'Which layout?', selected: ['abc'], typed: true }],
    },
  ]);
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

const twoOptions = (multiSelect = false) => ({
  ...layoutQuestion([
    { label: 'Stacked', description: 'One column.' },
    { label: 'Split', description: 'Two columns.' },
  ]),
  multiSelect,
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
        {
          label: 'Split',
          description: 'Two.',
          recommended: true,
          preview: 'two',
        },
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
  {
    rule: 'Shift+Tab goes to the previous question',
    keys: [shiftTab],
    shown: 'Third?',
  },
  {
    rule: 'Tab on the custom row switches question',
    keys: [down, down, tabKey],
    shown: 'Second?',
  },
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
    {
      kind: 'answered',
      answers: [{ question: 'Which layout?', selected: ['a'], typed: true }],
    },
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

  const { dialog } = open(questions, rows, 40);

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

it.each(rowCounts)('shows the typed custom text with a tall preview at %i rows', (rows) => {
  const { dialog } = previewFixture(rows, 30);

  for (const key of [down, down, 'z', 'z', 'z']) {
    dialog.handleInput(key);
  }

  const lines = dialog.render(60);

  expect(lines.some((line) => line.includes('zzz'))).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(rows - 6);
});

const wrapped = (prefix: string) =>
  [1, 2, 3].map((index) => `${prefix}${index}${'x'.repeat(21)}`).join(' ');

it.each(rowCounts)('clips header text only when it does not fit at %i rows', (rows) => {
  const make = (height: number) =>
    open(
      [
        {
          ...twoOptions(),
          question: wrapped('Q'),
          problem: wrapped('P'),
          impact: wrapped('I'),
        },
      ],
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
