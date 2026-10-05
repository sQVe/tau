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
import { handleKey, initialState, isCustomChecked, withCustomText } from './questionnaire.js';
import type {
  Answer,
  KeyPress,
  PreviewViewport,
  QuestionFacts,
  QuestionnaireState,
} from './questionnaire.js';

export interface DialogQuestion extends QuestionFacts {
  header: string;
  context: string;
  options: {
    label: string;
    description: string;
    recommended?: boolean;
    preview?: string;
  }[];
}

export interface DialogResult {
  cancelled: boolean;
  answers: Answer[];
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
const previewBar = ' │ ';
// Pi renders its widgets and a footer of two or more lines below the dialog.
const piChromeRows = 6;
// Below this many rows the dialog drops its borders and blank rows.
const compactRows = 12;
// A blank row, the key hints, and the border close the dialog.
const footerRows = 3;
// The full preview adds a border, a title, a blank row, and the hidden-line count to the footer.
const fullPreviewChromeRows = 7;
// The compact full preview keeps the title, the hidden-line count, and the key hints.
const compactFullPreviewChromeRows = 3;

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

  constructor(
    questions: DialogQuestion[],
    theme: Theme,
    terminal: TUI,
    done: (result: DialogResult) => void,
  ) {
    this.questions = questions;
    this.theme = theme;
    this.terminal = terminal;
    this.done = done;
    this.state = initialState(questions.length);

    this.inputs = questions.map(
      () =>
        new Input({
          prompt: '',
          placeholder: customLabel,
          placeholderStyle: (text) => theme.fg('dim', text),
        }),
    );
  }

  handleInput(data: string): void {
    const outcome = handleKey(this.state, readKey(data), this.questions, this.previewViewport());

    if (outcome.kind === 'cancel') {
      this.done({ cancelled: true, answers: [] });

      return;
    }

    if (outcome.kind === 'submit') {
      this.done({ cancelled: false, answers: outcome.answers });

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

    const preview = this.focusedOption(facts)?.preview;

    if (this.state.fullPreview !== undefined && preview !== undefined) {
      return this.renderFullPreview(facts, preview, width);
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
    return Math.max(1, this.availableRows() - fullPreviewChrome(this.compact()));
  }

  private previewViewport(): PreviewViewport {
    const facts = this.questions[this.state.tab];
    const preview = facts === undefined ? undefined : this.focusedOption(facts)?.preview;
    // Pi renders the dialog at the terminal width, which can change before the next render.
    const lineCount = wrapPreview(preview ?? '', this.terminal.terminal.columns).length;

    return { rows: this.fullPreviewRows(), lineCount };
  }

  private focusedOption(facts: DialogQuestion): DialogQuestion['options'][number] | undefined {
    return facts.options[this.state.questions[this.state.tab]?.cursor ?? 0];
  }

  private footer(keys: string[], width: number): string[] {
    const hint = truncateToWidth(this.theme.fg('dim', ` ${keys.join(' • ')}`), width);

    return this.compact() ? [hint] : ['', hint, this.theme.fg('accent', '─'.repeat(width))];
  }

  // Fits the header into `rows`. The question and the context keep a row each before the tabs get
  // any, and the tabs are dropped when they do not fit whole.
  private header(facts: DialogQuestion, width: number, rows: number): string[] {
    // The border and the blank row below the context take two rows unless compact.
    const textRows = Math.max(1, this.compact() ? rows : rows - 2);
    const question = wrapWithPrefix(' ', this.theme.bold(facts.question), width);
    const context = wrapWithPrefix(' ', this.theme.fg('muted', facts.context), width);
    const shownQuestion = clipLines(question, Math.max(1, textRows - 1), width);
    const shownContext = clipLines(context, textRows - shownQuestion.length, width);
    const tabs = this.tabBar(width);
    const tabRows = textRows - shownQuestion.length - shownContext.length;
    const text = [...(tabs.length <= tabRows ? tabs : []), ...shownQuestion, ...shownContext];

    if (this.compact()) {
      return text;
    }

    return [this.theme.fg('accent', '─'.repeat(width)), ...text, ''];
  }

  // The footer, the focused option, and the smallest preview come before the header.
  private fitHeader(facts: DialogQuestion, width: number, focusedRows: number, minimum: number) {
    const headerRows = this.availableRows() - this.footerRows() - focusedRows - minimum;
    const header = this.header(facts, width, headerRows);
    const room = this.availableRows() - header.length - this.footerRows();

    return { header, room };
  }

  // Sizes the header and the preview. A preview that cannot keep its minimum gives its reserved
  // rows back to the header.
  private layout(
    facts: DialogQuestion,
    width: number,
    space: Omit<PreviewSpace, 'room'>,
    previewHeight: number,
  ) {
    const reserved = this.fitHeader(facts, width, space.focusedRows, space.minimum);
    const previewRows = previewRoom({ ...space, room: reserved.room }, previewHeight);

    if (previewRows > 0 || space.minimum === 0) {
      return { ...reserved, previewRows };
    }

    return { ...this.fitHeader(facts, width, space.focusedRows, 0), previewRows };
  }

  private renderOptions(facts: DialogQuestion, width: number): string[] {
    const previewLines = this.focusedOption(facts)?.preview?.split('\n') ?? [];
    const minimum = previewLines.length === 0 ? 0 : this.minimumPreviewRows();
    const blocks = [...this.optionBlocks(facts, width), [this.customRow(facts, width)]];
    const cursor = this.state.questions[this.state.tab]?.cursor ?? 0;
    const focusedRows = blocks[cursor]?.length ?? 1;
    const previewHeight = previewLines.length + this.previewTitleRows();

    const space = { optionRows: blocks.flat().length, focusedRows, minimum };
    const { header, room, previewRows } = this.layout(facts, width, space, previewHeight);
    const preview = this.preview(facts, width, previewRows);
    const options = visibleOptions(blocks, cursor, room - preview.length);

    const tooTall = preview.length < previewHeight;
    const tooWide = previewLines.some((line) => visibleWidth(line) > previewWidth(width));
    const hidesPart = tooTall || tooWide;
    const clipped = previewLines.length > 0 && hidesPart;

    return [
      ...header,
      ...options,
      ...preview,
      ...this.footer(this.hintKeys(facts, clipped), width),
    ];
  }

  private renderFullPreview(facts: DialogQuestion, preview: string, width: number): string[] {
    const { theme } = this;
    const all = wrapPreview(preview, width);
    const rows = this.fullPreviewRows();
    const offset = Math.min(this.state.fullPreview?.offset ?? 0, Math.max(0, all.length - rows));
    const bar = theme.fg('muted', previewBar);
    const shown = all.slice(offset, offset + rows);
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));
    const hidden = all.length - offset - shown.length;

    // The smallest compact view has no row left for the hidden-line count.
    const countFits = lines.length + fullPreviewChrome(this.compact()) <= this.availableRows();

    if (hidden > 0 && countFits) {
      lines.push(bar + theme.fg('dim', `… ${hidden} more lines`));
    }

    const label = this.focusedOption(facts)?.label ?? '';
    const title = truncateToWidth(theme.bold(` Preview: ${label}`), width);
    const keys = all.length > rows ? ['↑↓ scroll', 'Ctrl+O or Esc back'] : ['Ctrl+O or Esc back'];
    const footer = this.footer(keys, width);

    if (this.compact()) {
      return [title, ...lines, ...footer];
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

  private preview(facts: DialogQuestion, width: number, rows: number): string[] {
    const option = this.focusedOption(facts);

    if (option?.preview === undefined || rows < this.minimumPreviewRows()) {
      return [];
    }

    const all = option.preview.split('\n');
    const fits = all.length + this.previewTitleRows() <= rows;
    const shown = fits ? all : all.slice(0, rows - this.minimumPreviewRows());
    const hidden = all.length - shown.length;
    const bar = this.theme.fg('muted', previewBar);
    const title = truncateToWidth(this.theme.fg('muted', ` Preview: ${option.label}`), width);
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));

    if (hidden > 0) {
      lines.push(bar + this.theme.fg('dim', `… ${hidden} more lines`));
    }

    return this.compact() ? [title, ...lines] : ['', title, ...lines];
  }

  private hintKeys(facts: DialogQuestion, previewClipped: boolean): string[] {
    const keys = facts.multiSelect
      ? ['↑↓ move', 'Space check', 'Enter submit']
      : ['↑↓ move', 'Enter select'];

    // The footer truncates to one row, so the only way to read a clipped preview comes first.
    if (previewClipped) {
      keys.unshift('Ctrl+O full preview');
    }

    if (this.questions.length > 1) {
      keys.push('Tab switch question');
    }

    keys.push('Esc cancel');

    return keys;
  }
}

export const questionDialog =
  (questions: DialogQuestion[]): DialogFactory =>
  (terminal, theme, _keybindings, done) =>
    new QuestionDialog(questions, theme, terminal, done);
