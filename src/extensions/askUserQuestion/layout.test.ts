import { expect, it } from 'vitest';

import { fullPreviewLayout, isCompact, optionLayout, previewRoom } from './layout.js';

const space = (room: number, optionRows: number, focusedRows: number, minimum: number) => ({
  room,
  optionRows,
  focusedRows,
  minimum,
});

it.each([
  {
    rule: 'gives the preview all the rows the options leave free',
    space: space(18, 4, 3, 3),
    previewHeight: 20,
    rows: 14,
  },
  {
    rule: 'lets half the room win over a tall option list',
    space: space(18, 10, 3, 3),
    previewHeight: 20,
    rows: 9,
  },
  {
    rule: 'hides the preview under its minimum',
    space: space(2, 0, 0, 3),
    previewHeight: 20,
    rows: 0,
  },
  {
    rule: 'keeps its minimum when the focused option is taller than the room',
    space: space(4, 1, 10, 1),
    previewHeight: 20,
    rows: 1,
  },
  {
    rule: 'never clips a focused option that fits the room',
    space: space(10, 3, 6, 1),
    previewHeight: 20,
    rows: 4,
  },
  {
    rule: 'caps the preview at its own height',
    space: space(18, 4, 3, 3),
    previewHeight: 6,
    rows: 6,
  },
] as const)('previewRoom $rule', ({ space: previewSpace, previewHeight, rows }) => {
  expect(previewRoom(previewSpace, previewHeight)).toBe(rows);
});

it.each([
  [17, true],
  [18, false],
  [19, false],
  [13, true],
  [12, true],
] as const)('treats %i terminal rows as compact: %s', (terminalRows, compact) => {
  expect(isCompact(terminalRows)).toBe(compact);
});

it.each([
  {
    rule: 'a roomy dialog gives the header its budget and shows the whole preview',
    facts: {
      terminalRows: 24,
      questionLineCount: 1,
      problemLineCount: 1,
      impactLineCount: 1,
      tabLineCount: 0,
      optionRows: 3,
      focusedStart: 0,
      focusedRows: 2,
      previewLineCount: 1,
    },
    headerRows: 5,
    preview: { lineCount: 3, shownRows: 1, hiddenRows: 0 },
    optionWindow: { start: 0, count: 3 },
    compact: false,
  },
  {
    rule: 'a short dialog hides a preview that leaves the focused option no row',
    facts: {
      terminalRows: 10,
      questionLineCount: 1,
      problemLineCount: 1,
      impactLineCount: 1,
      tabLineCount: 0,
      optionRows: 3,
      focusedStart: 0,
      focusedRows: 2,
      previewLineCount: 1,
    },
    headerRows: 2,
    preview: { lineCount: 0, shownRows: 0, hiddenRows: 0 },
    optionWindow: { start: 0, count: 1 },
    compact: true,
  },
  {
    rule: 'decorates the header at the exact border threshold',
    facts: {
      terminalRows: 24,
      questionLineCount: 1,
      problemLineCount: 1,
      impactLineCount: 1,
      tabLineCount: 0,
      optionRows: 12,
      focusedStart: 0,
      focusedRows: 10,
      previewLineCount: 0,
    },
    headerRows: 5,
    preview: { lineCount: 0, shownRows: 0, hiddenRows: 0 },
    optionWindow: { start: 0, count: 10 },
    compact: false,
  },
  {
    rule: 'keeps tabs that fit the header exactly',
    facts: {
      terminalRows: 24,
      questionLineCount: 1,
      problemLineCount: 1,
      impactLineCount: 1,
      tabLineCount: 1,
      optionRows: 12,
      focusedStart: 0,
      focusedRows: 9,
      previewLineCount: 0,
    },
    headerRows: 6,
    preview: { lineCount: 0, shownRows: 0, hiddenRows: 0 },
    optionWindow: { start: 0, count: 9 },
    compact: false,
  },
  {
    rule: 'clips long header text to the header budget',
    facts: {
      terminalRows: 24,
      questionLineCount: 4,
      problemLineCount: 4,
      impactLineCount: 4,
      tabLineCount: 0,
      optionRows: 7,
      focusedStart: 0,
      focusedRows: 2,
      previewLineCount: 0,
    },
    headerRows: 13,
    preview: { lineCount: 0, shownRows: 0, hiddenRows: 0 },
    optionWindow: { start: 0, count: 2 },
    compact: false,
  },
  {
    rule: 'scrolls to keep the focused option at the end visible',
    facts: {
      terminalRows: 24,
      questionLineCount: 3,
      problemLineCount: 3,
      impactLineCount: 3,
      tabLineCount: 0,
      optionRows: 10,
      focusedStart: 8,
      focusedRows: 2,
      previewLineCount: 0,
    },
    headerRows: 11,
    preview: { lineCount: 0, shownRows: 0, hiddenRows: 0 },
    optionWindow: { start: 6, count: 4 },
    compact: false,
  },
] as const)('optionLayout $rule', ({ facts, headerRows, preview, optionWindow, compact }) => {
  const plan = optionLayout(facts);
  const { lineCount, shownRows, hiddenRows } = plan.preview;

  expect(plan.compact).toBe(compact);
  expect(plan.header.lineCount).toBe(headerRows);
  expect({ lineCount, shownRows, hiddenRows }).toEqual(preview);
  expect(plan.optionWindow).toEqual(optionWindow);
});

it.each([
  {
    rule: 'a roomy full preview shows the viewport and the hidden-line count',
    facts: { terminalRows: 24, wrappedLineCount: 35, savedOffset: 0 },
    plan: {
      compact: false,
      rows: 11,
      offset: 0,
      shownRows: 11,
      hiddenRows: 24,
      showCount: true,
      titleShown: true,
      canScroll: true,
    },
  },
  {
    rule: 'a compact full preview has no room for the hidden-line count',
    facts: { terminalRows: 9, wrappedLineCount: 5, savedOffset: 0 },
    plan: {
      compact: true,
      rows: 1,
      offset: 0,
      shownRows: 1,
      hiddenRows: 4,
      showCount: false,
      titleShown: true,
      canScroll: true,
    },
  },
  {
    rule: 'clamps a saved offset past the last page',
    facts: { terminalRows: 9, wrappedLineCount: 5, savedOffset: 40 },
    plan: {
      compact: true,
      rows: 1,
      offset: 4,
      shownRows: 1,
      hiddenRows: 0,
      showCount: false,
      titleShown: true,
      canScroll: true,
    },
  },
  {
    rule: 'stops scrolling once the viewport holds every wrapped line',
    facts: { terminalRows: 24, wrappedLineCount: 11, savedOffset: 0 },
    plan: {
      compact: false,
      rows: 11,
      offset: 0,
      shownRows: 11,
      hiddenRows: 0,
      showCount: false,
      titleShown: true,
      canScroll: false,
    },
  },
] as const)('fullPreviewLayout $rule', ({ facts, plan }) => {
  expect(fullPreviewLayout(facts)).toEqual(plan);
});
