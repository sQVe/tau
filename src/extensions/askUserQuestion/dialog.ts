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

import { isBottom, isDown, isTop, isUp } from '../../dialog/keys.js';
import { fullPreviewLayout, isCompact, optionLayout } from './layout.js';
import type { HeaderPlan, PreviewPlan } from './layout.js';
import {
  handleKey,
  initialState,
  isCustomChecked,
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

export type DialogResult = { kind: 'answered'; answers: Answer[] } | { kind: 'declined' };

type DialogFactory = (
  terminal: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: DialogResult) => void,
) => QuestionDialog;

const customLabel = 'Type something.';
const previewBar = ' │ ';

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
    this.state = initialState(questions);

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
  }

  handleInput(data: string): void {
    const key = readKey(data);

    const outcome = handleKey(this.state, key, this.questions, this.previewViewport());

    if (outcome.kind === 'cancel') {
      this.done({ kind: 'declined' });

      return;
    }

    if (outcome.kind === 'submit') {
      this.done({ kind: 'answered', answers: outcome.answers });

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

  private previewViewport(): PreviewViewport {
    const facts = this.questions[this.state.tab];
    const preview = facts === undefined ? undefined : this.focusedPreview(facts)?.text;
    // Pi renders the dialog at the terminal width, which can change before the next render.
    const lineCount = wrapPreview(preview ?? '', this.terminal.terminal.columns).length;

    const plan = fullPreviewLayout({
      terminalRows: this.terminal.terminal.rows,
      wrappedLineCount: lineCount,
      savedOffset: 0,
    });

    return { rows: plan.rows, lineCount };
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

    return isCompact(this.terminal.terminal.rows)
      ? [hint]
      : ['', hint, this.theme.fg('accent', '─'.repeat(width))];
  }

  private header(
    plan: HeaderPlan,
    width: number,
    wrapped: {
      question: string[];
      problem: string[];
      impact: string[];
      tabs: string[];
    },
  ): string[] {
    const shownQuestion = clipLines(wrapped.question, plan.questionRows, width);
    const shownProblem = clipLines(wrapped.problem, plan.problemRows, width);
    const shownImpact = clipLines(wrapped.impact, plan.impactRows, width);

    const text = [
      ...(plan.tabsFit ? wrapped.tabs : []),
      ...shownQuestion,
      ...shownProblem,
      ...shownImpact,
    ];

    if (!plan.decorated) {
      return text;
    }

    return [this.theme.fg('accent', '─'.repeat(width)), ...text, ''];
  }

  private hidesPart(
    previewLines: string[],
    shown: string[],
    width: number,
    titleRows: number,
  ): boolean {
    const tooTall = shown.length < previewLines.length + titleRows;
    const tooWide = previewLines.some((line) => visibleWidth(line) > previewWidth(width));

    return tooTall || tooWide;
  }

  private renderOptions(facts: DialogQuestion, width: number): string[] {
    const wrapped = {
      question: wrapWithPrefix(' ', this.theme.bold(facts.question), width),
      problem: wrapWithPrefix(' ', this.theme.fg('muted', facts.problem), width),
      impact: wrapWithPrefix(' ', this.theme.fg('dim', `Impact: ${facts.impact}`), width),
      tabs: this.tabBar(width),
    };

    const blocks = [...this.optionBlocks(facts, width), [this.customRow(facts, width)]];

    const focused = this.focusedPreview(facts);
    const previewLines = focused?.text.split('\n') ?? [];
    const cursor = this.state.questions[this.state.tab]?.cursor ?? 0;
    const focusedRows = blocks[cursor]?.length ?? 1;
    const focusedStart = blocks.slice(0, cursor).flat().length;

    const plan = optionLayout({
      terminalRows: this.terminal.terminal.rows,
      questionLineCount: wrapped.question.length,
      problemLineCount: wrapped.problem.length,
      impactLineCount: wrapped.impact.length,
      tabLineCount: wrapped.tabs.length,
      optionRows: blocks.flat().length,
      focusedStart,
      focusedRows,
      previewLineCount: previewLines.length,
    });

    const header = this.header(plan.header, width, wrapped);
    const preview = this.preview(focused, width, plan.preview, previewLines);

    const options = blocks
      .flat()
      .slice(plan.optionWindow.start, plan.optionWindow.start + plan.optionWindow.count);

    const clipped =
      previewLines.length > 0 &&
      this.hidesPart(previewLines, preview, width, plan.preview.titleRows);

    return [
      ...header,
      ...options,
      ...preview,
      ...this.footer(this.hintKeys(facts, clipped), width),
    ];
  }

  private renderFullPreview(preview: { text: string; title: string }, width: number): string[] {
    const { theme } = this;
    const all = wrapPreview(preview.text, width);

    const plan = fullPreviewLayout({
      terminalRows: this.terminal.terminal.rows,
      wrappedLineCount: all.length,
      savedOffset: this.state.fullPreview?.offset ?? 0,
    });

    const bar = theme.fg('muted', previewBar);
    const shown = all.slice(plan.offset, plan.offset + plan.shownRows);
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));

    if (plan.showCount) {
      lines.push(truncateToWidth(bar + theme.fg('dim', `… ${plan.hiddenRows} more lines`), width));
    }

    const title = truncateToWidth(theme.bold(preview.title), width);
    const keys = plan.canScroll ? ['↑↓ scroll', 'Ctrl+O or Esc back'] : ['Ctrl+O or Esc back'];
    const footer = this.footer(keys, width);

    if (plan.compact) {
      const titleRows = plan.titleShown ? [title] : [];

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

    return isCompact(this.terminal.terminal.rows) ? tabRows : [...tabRows, ''];
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

  private preview(
    focused: { text: string; title: string } | undefined,
    width: number,
    plan: PreviewPlan,
    previewLines: string[],
  ): string[] {
    if (focused === undefined || plan.lineCount === 0) {
      return [];
    }

    const shown = previewLines.slice(0, plan.shownRows);
    const bar = this.theme.fg('muted', previewBar);
    const title = truncateToWidth(this.theme.fg('muted', focused.title), width);
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));

    if (plan.hiddenRows > 0) {
      lines.push(
        truncateToWidth(bar + this.theme.fg('dim', `… ${plan.hiddenRows} more lines`), width),
      );
    }

    return plan.compact ? [title, ...lines] : ['', title, ...lines];
  }

  private selectionKeys(facts: DialogQuestion): string[] {
    return facts.multiSelect
      ? ['↑↓ move', 'Space check', 'Enter submit']
      : ['↑↓ move', 'Enter select'];
  }

  private hintKeys(facts: DialogQuestion, previewClipped: boolean): string[] {
    const keys = this.selectionKeys(facts);

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
