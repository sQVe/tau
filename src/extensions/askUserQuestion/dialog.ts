import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';

import { isBottom, isDown, isTop, isUp } from '../../keys.js';
import type { WorkerNoticeEvent } from '../../worker.js';
import {
  handleKey,
  initialState,
  isCustomChecked,
  restoredState,
  shownPreview,
  withCustomText,
} from './questionnaire.js';
import type {
  Answer,
  KeyPress,
  PreviewViewport,
  QuestionFacts,
  QuestionnaireState,
} from './questionnaire.js';

export interface DialogQuestion extends QuestionFacts {
  header: string;
  problem: string;
  impact: string;
  options: {
    label: string;
    description: string;
    recommended?: boolean;
    preview?: string;
  }[];
}

export type DialogResult =
  | { kind: 'answered'; answers: Answer[] }
  | { kind: 'declined' }
  | { kind: 'deferred'; notices: WorkerNoticeEvent[] };

export interface DialogSession {
  // The state a deferred dialog saved for the same questions.
  saved: QuestionnaireState | undefined;
  save: (state: QuestionnaireState) => void;
  subscribe: (listener: (notice: WorkerNoticeEvent) => void) => () => void;
}

type DialogFactory = (
  terminal: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: DialogResult) => void,
) => QuestionDialog;

interface PreviewSpace {
  room: number;
  optionRows: number;
  focusedRows: number;
  minimum: number;
}

const customLabel = 'Type something.';
// The question and the problem. The impact is the first row dropped when rows run short.
const minimumHeaderRows = 2;
const previewBar = ' │ ';
// Pi renders its widgets and a footer of two or more lines below the dialog.
const piChromeRows = 6;
// Below this many rows the dialog drops its borders and blank rows.
const compactRows = 12;
// The border, the question, the problem, the impact, and the blank row below them.
const decoratedHeaderRows = 5;
// A blank row, the key hints, and the border close the dialog.
const footerRows = 3;
// The full preview adds a border, a title, a blank row, and the hidden-line count to the footer.
const fullPreviewChromeRows = 7;
// The compact full preview adds the title, the hidden-line count, and the key hints. The title is
// the first row dropped when a waiting notice leaves no room.
const compactFullPreviewChromeRows = 3;

const workerNoticeCount = (count: number) =>
  count === 1 ? '1 worker notice' : `${count} worker notices`;

export const actionLabel = (notices: readonly WorkerNoticeEvent[]): string => {
  const [first] = notices;

  if (notices.length === 1 && first !== undefined) {
    return `Handle the notice from ${first.worker} first`;
  }

  return `Handle the ${workerNoticeCount(notices.length)} first`;
};

const fullPreviewChrome = (compact: boolean) =>
  compact ? compactFullPreviewChromeRows : fullPreviewChromeRows;

const readKey = (data: string): KeyPress => {
  if (matchesKey(data, Key.ctrl('o'))) {
    return { kind: 'preview' };
  }

  if (matchesKey(data, Key.enter)) {
    return { kind: 'enter' };
  }

  if (matchesKey(data, Key.escape)) {
    return { kind: 'cancel' };
  }

  if (matchesKey(data, Key.shift('tab'))) {
    return { kind: 'previousQuestion' };
  }

  if (matchesKey(data, Key.tab)) {
    return { kind: 'nextQuestion' };
  }

  if (matchesKey(data, Key.space)) {
    return { kind: 'space' };
  }

  // Vim letters navigate option rows but are text on the custom row.
  const typed = ![Key.up, Key.down, Key.home, Key.end].some((key) => matchesKey(data, key));

  if (isUp(data)) {
    return { kind: 'up', typed };
  }

  if (isDown(data)) {
    return { kind: 'down', typed };
  }

  if (isTop(data)) {
    return { kind: 'top', typed };
  }

  if (isBottom(data)) {
    return { kind: 'bottom', typed };
  }

  return { kind: 'other' };
};

const wrapWithPrefix = (prefix: string, text: string, width: number): string[] => {
  const prefixWidth = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
  const indent = ' '.repeat(prefixWidth);

  return wrapped.map((line, index) => `${index === 0 ? prefix : indent}${line}`);
};

const previewWidth = (width: number) => Math.max(1, width - visibleWidth(previewBar));

const wrapPreview = (preview: string, width: number): string[] =>
  preview.split('\n').flatMap((line) => wrapTextWithAnsi(line, previewWidth(width)));

// Scrolls the option rows so the focused option stays visible within `room` lines.
const visibleOptions = (blocks: string[][], cursor: number, room: number): string[] => {
  const lines = blocks.flat();

  if (lines.length <= room) {
    return lines;
  }

  const start = blocks.slice(0, cursor).flat().length;
  const end = start + (blocks[cursor]?.length ?? 1);
  const first = Math.min(start, Math.max(0, end - room));

  return lines.slice(first, first + Math.max(1, room));
};

// The preview takes its rows before the options: at least its minimum, up to half the room, or all
// the rows the options leave free. It never hides part of a focused option that fits the room. When
// the focused option does not fit, the preview keeps its minimum and one row stays for the label.
const previewRoom = (space: PreviewSpace, previewHeight: number) => {
  const { room, optionRows, focusedRows, minimum } = space;
  const wanted = Math.max(room - optionRows, Math.floor(room / 2), minimum);
  const limit = focusedRows <= room ? room - focusedRows : Math.min(minimum, room - 1);
  const rows = Math.min(previewHeight, wanted, limit);

  return rows < minimum ? 0 : rows;
};

const clipLines = (lines: string[], rows: number, width: number): string[] => {
  if (rows <= 0) {
    return [];
  }

  if (lines.length <= rows) {
    return lines;
  }

  const last = lines[rows - 1] ?? '';

  return [...lines.slice(0, rows - 1), truncateToWidth(`${last} …`, width)];
};

class QuestionDialog implements Component {
  private readonly questions: DialogQuestion[];
  private readonly theme: Theme;
  private readonly terminal: TUI;
  private readonly done: (result: DialogResult) => void;
  private state: QuestionnaireState;
  private readonly inputs: Input[];
  // One entry per worker. A later notice replaces that worker's label.
  private readonly notices = new Map<string, WorkerNoticeEvent>();
  private readonly save: (state: QuestionnaireState) => void;
  private readonly unsubscribe: () => void;

  constructor(
    questions: DialogQuestion[],
    theme: Theme,
    terminal: TUI,
    done: (result: DialogResult) => void,
    session: DialogSession,
  ) {
    this.questions = questions;
    this.theme = theme;
    this.terminal = terminal;
    this.save = session.save;

    this.done = (result) => {
      this.unsubscribe();
      done(result);
    };

    this.state =
      session.saved === undefined
        ? initialState(questions)
        : restoredState(session.saved, questions);

    this.inputs = questions.map(
      () =>
        new Input({
          prompt: '',
          placeholder: customLabel,
          placeholderStyle: (text) => theme.fg('dim', text),
        }),
    );

    this.inputs.forEach((input, index) => {
      input.setValue(this.state.questions[index]?.customText ?? '');
    });

    this.unsubscribe = session.subscribe((notice) => {
      this.notices.set(notice.worker, notice);
      this.terminal.requestRender();
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  handleInput(data: string): void {
    const deferAvailable = this.notices.size > 0;
    const key = readKey(data);

    const outcome = handleKey(
      this.state,
      key,
      this.questions,
      this.previewViewport(),
      deferAvailable,
    );

    if (outcome.kind === 'cancel') {
      this.done({ kind: 'declined' });

      return;
    }

    if (outcome.kind === 'submit') {
      this.done({ kind: 'answered', answers: outcome.answers });

      return;
    }

    if (outcome.kind === 'defer') {
      this.save(this.state);
      this.done({ kind: 'deferred', notices: [...this.notices.values()] });

      return;
    }

    if (outcome.kind === 'type') {
      const input = this.inputs[this.state.tab];

      input?.handleInput(data);
      this.state = withCustomText(this.state, input?.getValue() ?? '');
    } else {
      this.state = outcome.state;
    }

    this.terminal.requestRender();
  }

  invalidate(): void {
    for (const input of this.inputs) {
      input.invalidate();
    }
  }

  render(width: number): string[] {
    const facts = this.questions[this.state.tab];
    const border = this.theme.fg('accent', '─'.repeat(width));

    if (facts === undefined) {
      return [border, border];
    }

    const preview = this.focusedPreview(facts);

    if (this.state.fullPreview !== undefined && preview !== undefined) {
      return this.renderFullPreview(preview, width);
    }

    return this.renderOptions(facts, width);
  }

  // Pi shows only the last rows of a component taller than the terminal, hiding the question.
  private availableRows(): number {
    return this.terminal.terminal.rows - piChromeRows;
  }

  private compact(): boolean {
    return this.availableRows() < compactRows;
  }

  // A title, and a blank row above it unless compact.
  private previewTitleRows(): number {
    return this.compact() ? 1 : 2;
  }

  // The title rows and the line that counts hidden lines.
  private minimumPreviewRows(): number {
    return this.previewTitleRows() + 1;
  }

  // The compact footer keeps only the key hints.
  private footerRows(): number {
    return this.compact() ? 1 : footerRows;
  }

  private fullPreviewRows(): number {
    const indicatorRows = this.notices.size > 0 ? 1 : 0;

    return Math.max(1, this.availableRows() - fullPreviewChrome(this.compact()) - indicatorRows);
  }

  private previewViewport(): PreviewViewport {
    const facts = this.questions[this.state.tab];
    const preview = facts === undefined ? undefined : this.focusedPreview(facts)?.text;
    // Pi renders the dialog at the terminal width, which can change before the next render.
    const lineCount = wrapPreview(preview ?? '', this.terminal.terminal.columns).length;

    return { rows: this.fullPreviewRows(), lineCount };
  }

  // An option's own preview replaces the question's preview. Only the question's preview has a
  // title that does not name an option.
  private focusedPreview(facts: DialogQuestion): { text: string; title: string } | undefined {
    const cursor = this.state.questions[this.state.tab]?.cursor ?? 0;
    const text = shownPreview(facts, cursor);

    if (text === undefined) {
      return undefined;
    }

    const option = facts.options[cursor];
    const title = option?.preview === undefined ? ' Preview' : ` Preview: ${option.label}`;

    return { text, title };
  }

  private footer(keys: string[], width: number): string[] {
    const hint = truncateToWidth(this.theme.fg('dim', ` ${keys.join(' • ')}`), width);

    return this.compact() ? [hint] : ['', hint, this.theme.fg('accent', '─'.repeat(width))];
  }

  // Fits the header into `rows`. The question, the problem, and the impact keep a row each before
  // the border, the blank row, or the tabs get any. When rows run short, the impact goes first,
  // then the problem, and the question stays. The tabs are dropped when they do not fit whole.
  private header(facts: DialogQuestion, width: number, rows: number): string[] {
    const decorated = !this.compact() && rows >= decoratedHeaderRows;
    const textRows = Math.max(1, decorated ? rows - 2 : rows);
    const question = wrapWithPrefix(' ', this.theme.bold(facts.question), width);
    const problem = wrapWithPrefix(' ', this.theme.fg('muted', facts.problem), width);
    const impact = wrapWithPrefix(' ', this.theme.fg('dim', `Impact: ${facts.impact}`), width);
    const shownQuestion = clipLines(question, Math.max(1, textRows - 2), width);
    const remainingRows = textRows - shownQuestion.length;
    const problemRows = remainingRows <= 0 ? 0 : Math.max(1, remainingRows - 1);
    const shownProblem = clipLines(problem, problemRows, width);
    const impactRows = textRows - shownQuestion.length - shownProblem.length;
    const shownImpact = clipLines(impact, impactRows, width);
    const tabs = this.tabBar(width);
    const tabRows = impactRows - shownImpact.length;
    const shownText = [...shownQuestion, ...shownProblem, ...shownImpact];
    const text = [...(tabs.length <= tabRows ? tabs : []), ...shownText];

    if (!decorated) {
      return text;
    }

    return [this.theme.fg('accent', '─'.repeat(width)), ...text, ''];
  }

  // The footer and the focused option come before the header. The smallest preview comes before
  // all of the header except the question and the problem.
  private fitHeader(
    facts: DialogQuestion,
    width: number,
    space: { focusedRows: number; minimum: number; noticeRows: number },
  ) {
    const { focusedRows, minimum, noticeRows } = space;

    const free = this.availableRows() - this.footerRows() - noticeRows;
    // A long focused option is clipped to one row before the question and the problem lose theirs.
    const guaranteed = Math.min(minimumHeaderRows, free - 1);
    const headerRows = Math.max(guaranteed, free - focusedRows - minimum);

    const header = this.header(facts, width, headerRows);
    const room = this.availableRows() - header.length - this.footerRows() - noticeRows;

    return { header, room };
  }

  // The blank separator goes first when the action row has no room for both rows.
  private dropSeparator(blocks: string[][], facts: DialogQuestion, width: number, room: number) {
    if (room < 2 && blocks.length > facts.options.length + 1) {
      blocks.splice(-1, 1, ...this.actionBlocks(width, false));
    }
  }

  private hidesPart(previewLines: string[], shown: string[], width: number): boolean {
    const tooTall = shown.length < previewLines.length + this.previewTitleRows();
    const tooWide = previewLines.some((line) => visibleWidth(line) > previewWidth(width));

    return tooTall || tooWide;
  }

  private renderOptions(facts: DialogQuestion, width: number): string[] {
    const previewLines = this.focusedPreview(facts)?.text.split('\n') ?? [];
    const minimum = previewLines.length === 0 ? 0 : this.minimumPreviewRows();

    const blocks = [
      ...this.optionBlocks(facts, width),
      [this.customRow(facts, width)],
      ...this.actionBlocks(width),
    ];

    const noticeLines = this.noticeLines(width);
    const cursor = this.state.questions[this.state.tab]?.cursor ?? 0;
    const focusedRows = blocks[cursor]?.length ?? 1;
    const previewHeight = previewLines.length + this.previewTitleRows();

    const { header, room } = this.fitHeader(facts, width, {
      focusedRows,
      minimum,
      noticeRows: noticeLines.length,
    });

    this.dropSeparator(blocks, facts, width, room);

    const space = { room, optionRows: blocks.flat().length, focusedRows, minimum };
    const preview = this.preview(facts, width, previewRoom(space, previewHeight));
    const options = visibleOptions(blocks, cursor, room - preview.length);

    const clipped = previewLines.length > 0 && this.hidesPart(previewLines, preview, width);

    return [
      ...header,
      ...options,
      ...noticeLines,
      ...preview,
      ...this.footer(this.hintKeys(facts, clipped, noticeLines.length === 0), width),
    ];
  }

  private renderFullPreview(preview: { text: string; title: string }, width: number): string[] {
    const { theme } = this;
    const all = wrapPreview(preview.text, width);
    const rows = this.fullPreviewRows();
    const offset = Math.min(this.state.fullPreview?.offset ?? 0, Math.max(0, all.length - rows));
    const bar = theme.fg('muted', previewBar);
    const shown = all.slice(offset, offset + rows);
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));
    const hidden = all.length - offset - shown.length;

    // The smallest compact view has no row left for the hidden-line count.
    const noticeRows = this.notices.size > 0 ? 1 : 0;

    const countFits =
      lines.length + fullPreviewChrome(this.compact()) + noticeRows <= this.availableRows();

    if (hidden > 0 && countFits) {
      lines.push(truncateToWidth(bar + theme.fg('dim', `… ${hidden} more lines`), width));
    }

    const title = truncateToWidth(theme.bold(preview.title), width);
    const keys = all.length > rows ? ['↑↓ scroll', 'Ctrl+O or Esc back'] : ['Ctrl+O or Esc back'];
    const indicator = this.notices.size > 0 ? [this.noticeIndicator(width)] : [];
    const footer = [...indicator, ...this.footer(keys, width)];

    if (this.compact()) {
      const titleFits = lines.length + footer.length + 1 <= this.availableRows();
      const titleRows = titleFits ? [title] : [];

      return [...titleRows, ...lines, ...footer];
    }

    return [theme.fg('accent', '─'.repeat(width)), title, '', ...lines, ...footer];
  }

  private tabBar(width: number): string[] {
    if (this.questions.length < 2) {
      return [];
    }

    const tabs = this.questions.map((question, index) => {
      const answered = this.state.answers[index] !== undefined;
      const text = ` ${answered ? '■' : '□'} ${question.header} `;

      if (index === this.state.tab) {
        return this.theme.bg('selectedBg', this.theme.fg('text', text));
      }

      return this.theme.fg(answered ? 'success' : 'muted', text);
    });

    const tabRows = wrapTextWithAnsi(` ${tabs.join(' ')}`, width);

    return this.compact() ? tabRows : [...tabRows, ''];
  }

  private rowPrefix(facts: DialogQuestion, index: number, checked: boolean): string {
    const cursor = this.state.questions[this.state.tab]?.cursor;
    const pointer = cursor === index ? this.theme.fg('accent', '> ') : '  ';
    const box = checked ? '[x] ' : '[ ] ';

    return `${pointer}${index + 1}. ${facts.multiSelect ? box : ''}`;
  }

  private optionBlocks(facts: DialogQuestion, width: number): string[][] {
    const { theme } = this;
    const question = this.state.questions[this.state.tab];

    return facts.options.map((option, index) => {
      const prefix = this.rowPrefix(facts, index, question?.checked.includes(index) === true);
      const label = theme.fg(question?.cursor === index ? 'accent' : 'text', option.label);
      const badge = option.recommended === true ? ` ${theme.fg('success', '★ Recommended')}` : '';

      return [
        ...wrapWithPrefix(prefix, label + badge, width),
        ...wrapWithPrefix('      ', theme.fg('muted', option.description), width),
      ];
    });
  }

  private customRow(facts: DialogQuestion, width: number): string {
    const question = this.state.questions[this.state.tab];
    const input = this.inputs[this.state.tab];
    const customText = question?.customText ?? '';
    const index = facts.options.length;
    const prefix = this.rowPrefix(facts, index, isCustomChecked(customText));
    const focused = question?.cursor === index;

    if (input === undefined) {
      return truncateToWidth(prefix, width);
    }

    input.focused = focused;

    if (focused) {
      return prefix + (input.render(Math.max(1, width - visibleWidth(prefix)))[0] ?? '');
    }

    const text = customText === '' ? this.theme.fg('dim', customLabel) : customText;

    return truncateToWidth(prefix + text, width);
  }

  // The header keeps two rows and the options keep one, so the notices get what is left. Workers
  // that do not fit are counted in a last line.
  private noticeLines(width: number): string[] {
    const workers = [...this.notices.values()];
    const free = this.availableRows() - this.footerRows() - minimumHeaderRows - 1;

    if (workers.length <= free) {
      return workers.map((notice) => this.noticeLine(notice, width));
    }

    if (free < 1) {
      return [];
    }

    const shown = workers.slice(0, free - 1).map((notice) => this.noticeLine(notice, width));
    const more = this.theme.fg('warning', ` +${workers.length - shown.length} more`);

    return [...shown, truncateToWidth(more, width)];
  }

  private noticeLine(notice: WorkerNoticeEvent, width: number): string {
    return truncateToWidth(this.theme.fg('warning', ` ${notice.worker} · ${notice.label}`), width);
  }

  private noticeIndicator(width: number): string {
    const names = [...this.notices.keys()].join(', ');
    const text = ` ${workerNoticeCount(this.notices.size)} waiting: ${names}`;

    return truncateToWidth(this.theme.fg('warning', text), width);
  }

  // The action row sits below the custom row, apart from the answer rows by a blank line.
  private actionBlocks(width: number, separated = true): string[][] {
    if (this.notices.size === 0) {
      return [];
    }

    const text = actionLabel([...this.notices.values()]);
    const focused = this.state.questions[this.state.tab]?.cursor === this.actionRow();
    const pointer = focused ? this.theme.fg('accent', '> ') : '  ';
    const label = this.theme.fg(focused ? 'accent' : 'text', text);

    const row = truncateToWidth(pointer + label, width);
    const block = separated ? ['', row] : [row];

    return [block];
  }

  private actionRow(): number {
    return (this.questions[this.state.tab]?.options.length ?? 0) + 1;
  }

  private preview(facts: DialogQuestion, width: number, rows: number): string[] {
    const focused = this.focusedPreview(facts);

    if (focused === undefined || rows < this.minimumPreviewRows()) {
      return [];
    }

    const all = focused.text.split('\n');
    const fits = all.length + this.previewTitleRows() <= rows;
    const shown = fits ? all : all.slice(0, rows - this.minimumPreviewRows());
    const hidden = all.length - shown.length;
    const bar = this.theme.fg('muted', previewBar);
    const title = truncateToWidth(this.theme.fg('muted', focused.title), width);
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));

    if (hidden > 0) {
      lines.push(truncateToWidth(bar + this.theme.fg('dim', `… ${hidden} more lines`), width));
    }

    return this.compact() ? [title, ...lines] : ['', title, ...lines];
  }

  private selectionKeys(facts: DialogQuestion, onAction: boolean): string[] {
    if (onAction) {
      return ['↑↓ move', 'Enter handle notice first'];
    }

    return facts.multiSelect
      ? ['↑↓ move', 'Space check', 'Enter submit']
      : ['↑↓ move', 'Enter select'];
  }

  private hintKeys(
    facts: DialogQuestion,
    previewClipped: boolean,
    noticeLinesHidden: boolean,
  ): string[] {
    const onAction = this.state.questions[this.state.tab]?.cursor === this.actionRow();
    const keys = this.selectionKeys(facts, onAction);

    // The footer truncates to one row, so the only way to read a clipped preview comes first.
    if (previewClipped) {
      keys.unshift('Ctrl+O full preview');
    }

    // The waiting notices come before every key when the dialog has no row for their lines.
    if (noticeLinesHidden && this.notices.size > 0) {
      keys.unshift(`${workerNoticeCount(this.notices.size)} waiting below`);
    }

    if (this.questions.length > 1) {
      keys.push('Tab switch question');
    }

    keys.push('Esc cancel');

    return keys;
  }
}

export const questionDialog =
  (questions: DialogQuestion[], session: DialogSession): DialogFactory =>
  (terminal, theme, _keybindings, done) =>
    new QuestionDialog(questions, theme, terminal, done, session);
