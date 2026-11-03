export interface PreviewSpace {
  room: number;
  optionRows: number;
  focusedRows: number;
  minimum: number;
}

interface HeaderFacts {
  questionRows: number;
  problemRows: number;
  impactRows: number;
  tabRows: number;
}

export interface HeaderPlan {
  decorated: boolean;
  questionRows: number;
  problemRows: number;
  impactRows: number;
  tabsFit: boolean;
  lineCount: number;
}

export interface PreviewPlan {
  compact: boolean;
  lineCount: number;
  titleRows: number;
  shownRows: number;
  hiddenRows: number;
}

interface OptionWindow {
  start: number;
  count: number;
}

export interface OptionFacts {
  terminalRows: number;
  questionLineCount: number;
  problemLineCount: number;
  impactLineCount: number;
  tabLineCount: number;
  optionRows: number;
  focusedStart: number;
  focusedRows: number;
  previewLineCount: number;
}

export interface OptionPlan {
  compact: boolean;
  header: HeaderPlan;
  preview: PreviewPlan;
  optionWindow: OptionWindow;
}

export interface FullPreviewFacts {
  terminalRows: number;
  wrappedLineCount: number;
  savedOffset: number;
}

export interface FullPreviewPlan {
  compact: boolean;
  rows: number;
  offset: number;
  shownRows: number;
  hiddenRows: number;
  showCount: boolean;
  titleShown: boolean;
  canScroll: boolean;
}

export const previewRoom = (space: PreviewSpace, previewHeight: number): number => {
  const { room, optionRows, focusedRows, minimum } = space;
  const wanted = Math.max(room - optionRows, Math.floor(room / 2), minimum);
  const limit = focusedRows <= room ? room - focusedRows : Math.min(minimum, room - 1);
  const rows = Math.min(previewHeight, wanted, limit);

  return rows < minimum ? 0 : rows;
};

const minimumHeaderRows = 2;
// Pi renders its widgets and a footer of two or more lines below the dialog.
const piChromeRows = 6;
const compactRows = 12;
const decoratedHeaderRows = 5;
const footerRows = 3;
const fullPreviewChromeRows = 7;
const compactFullPreviewChromeRows = 3;

const fullPreviewChrome = (compact: boolean): number =>
  compact ? compactFullPreviewChromeRows : fullPreviewChromeRows;

const availableRows = (terminalRows: number): number => terminalRows - piChromeRows;

export const isCompact = (terminalRows: number): boolean =>
  availableRows(terminalRows) < compactRows;

const previewTitleRows = (compact: boolean): number => (compact ? 1 : 2);

const minimumPreviewRows = (compact: boolean): number => previewTitleRows(compact) + 1;

const footerRowCount = (compact: boolean): number => (compact ? 1 : footerRows);

const headerPlan = (facts: HeaderFacts, compact: boolean, rows: number): HeaderPlan => {
  const decorated = !compact && rows >= decoratedHeaderRows;
  const textRows = Math.max(1, decorated ? rows - 2 : rows);
  const questionRows = Math.max(1, textRows - 2);
  const shownQuestion = Math.min(facts.questionRows, questionRows);
  const remainingRows = textRows - shownQuestion;
  const problemRows = remainingRows <= 0 ? 0 : Math.max(1, remainingRows - 1);
  const shownProblem = Math.min(facts.problemRows, problemRows);
  const impactRows = textRows - shownQuestion - shownProblem;
  const shownImpact = Math.min(facts.impactRows, Math.max(0, impactRows));
  const tabRows = impactRows - shownImpact;
  const tabsFit = facts.tabRows <= tabRows;
  const textLineCount = shownQuestion + shownProblem + shownImpact + (tabsFit ? facts.tabRows : 0);
  const lineCount = textLineCount + (decorated ? 2 : 0);

  return {
    decorated,
    questionRows,
    problemRows,
    impactRows,
    tabsFit,
    lineCount,
  };
};

const previewPlan = (previewLineCount: number, compact: boolean, rows: number): PreviewPlan => {
  const titleRows = previewTitleRows(compact);

  if (rows === 0) {
    return { compact, lineCount: 0, titleRows, shownRows: 0, hiddenRows: 0 };
  }

  const fits = previewLineCount + titleRows <= rows;
  const shownRows = fits ? previewLineCount : rows - minimumPreviewRows(compact);
  const hiddenRows = previewLineCount - shownRows;

  return {
    compact,
    lineCount: titleRows + shownRows + (hiddenRows > 0 ? 1 : 0),
    titleRows,
    shownRows,
    hiddenRows,
  };
};

const visibleWindow = (
  totalRows: number,
  focusedStart: number,
  focusedRows: number,
  room: number,
): OptionWindow => {
  const end = focusedStart + focusedRows;
  const start = Math.min(focusedStart, Math.max(0, end - room));

  return { start, count: Math.min(totalRows, Math.max(1, room)) };
};

export const optionLayout = (facts: OptionFacts): OptionPlan => {
  const compact = isCompact(facts.terminalRows);
  const footerHeight = footerRowCount(compact);
  const minimum = facts.previewLineCount === 0 ? 0 : minimumPreviewRows(compact);
  const free = availableRows(facts.terminalRows) - footerHeight;
  const guaranteed = Math.min(minimumHeaderRows, free - 1);
  const headerBudget = Math.max(guaranteed, free - facts.focusedRows - minimum);

  const header = headerPlan(
    {
      questionRows: facts.questionLineCount,
      problemRows: facts.problemLineCount,
      impactRows: facts.impactLineCount,
      tabRows: facts.tabLineCount,
    },
    compact,
    headerBudget,
  );

  const room = availableRows(facts.terminalRows) - header.lineCount - footerHeight;

  const previewHeight =
    facts.previewLineCount === 0 ? 0 : facts.previewLineCount + previewTitleRows(compact);

  const allocated = previewRoom(
    {
      room,
      optionRows: facts.optionRows,
      focusedRows: facts.focusedRows,
      minimum,
    },
    previewHeight,
  );

  const preview = previewPlan(facts.previewLineCount, compact, allocated);

  const optionWindow = visibleWindow(
    facts.optionRows,
    facts.focusedStart,
    facts.focusedRows,
    room - preview.lineCount,
  );

  return { compact, header, preview, optionWindow };
};

export const fullPreviewLayout = (facts: FullPreviewFacts): FullPreviewPlan => {
  const compact = isCompact(facts.terminalRows);
  const available = availableRows(facts.terminalRows);
  const rows = Math.max(1, available - fullPreviewChrome(compact));
  const offset = Math.min(facts.savedOffset, Math.max(0, facts.wrappedLineCount - rows));
  const shownRows = Math.min(rows, facts.wrappedLineCount);
  const hiddenRows = facts.wrappedLineCount - offset - shownRows;
  const countFits = shownRows + fullPreviewChrome(compact) <= available;
  const showCount = hiddenRows > 0 && countFits;
  const titleShown = !compact || shownRows + footerRowCount(compact) + 1 <= available;
  const canScroll = facts.wrappedLineCount > rows;

  return {
    compact,
    rows,
    offset,
    shownRows,
    hiddenRows,
    showCount,
    titleShown,
    canScroll,
  };
};
