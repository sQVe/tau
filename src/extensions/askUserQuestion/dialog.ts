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
import type { Answer, KeyPress, QuestionFacts, QuestionnaireState } from './questionnaire.js';

export interface DialogQuestion extends QuestionFacts {
  header: string;
  options: { label: string; description: string; preview?: string }[];
}

export interface DialogResult {
  cancelled: boolean;
  answers: Answer[];
}

const customLabel = 'Type something.';
// Pi renders its widgets and a footer of two or more lines below the dialog.
const piChromeRows = 6;

const readKey = (data: string): KeyPress => {
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
    const outcome = handleKey(this.state, readKey(data), this.questions);

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
    const { theme } = this;
    const facts = this.questions[this.state.tab];
    const border = theme.fg('accent', '─'.repeat(width));

    if (facts === undefined) {
      return [border, border];
    }

    const header = [
      border,
      ...this.tabBar(width),
      ...wrapTextWithAnsi(theme.bold(` ${facts.question}`), width),
      '',
    ];

    const bottom = ['', truncateToWidth(theme.fg('dim', ` ${this.hint(facts)}`), width), border];
    // Pi shows only the last rows of a component taller than the terminal, hiding the question.
    const room = this.terminal.terminal.rows - piChromeRows - header.length - bottom.length;
    const blocks = [...this.optionBlocks(facts, width), [this.customRow(facts, width)]];
    const cursor = this.state.questions[this.state.tab]?.cursor ?? 0;
    const options = visibleOptions(blocks, cursor, room);
    const preview = this.preview(facts, width, room - options.length);

    return [...header, ...options, ...preview, ...bottom];
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

    return [...wrapTextWithAnsi(` ${tabs.join(' ')}`, width), ''];
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

      return [
        ...wrapWithPrefix(prefix, label, width),
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
    const cursor = this.state.questions[this.state.tab]?.cursor ?? 0;
    const preview = facts.options[cursor]?.preview;

    if (preview === undefined || preview === '' || rows < 3) {
      return [];
    }

    const all = preview.split('\n');
    const shown = all.length < rows ? all : all.slice(0, rows - 2);
    const hidden = all.length - shown.length;
    const bar = this.theme.fg('muted', ' │ ');
    const lines = shown.map((line) => truncateToWidth(`${bar}${line}`, width));

    if (hidden > 0) {
      lines.push(bar + this.theme.fg('dim', `… ${hidden} more lines`));
    }

    return ['', ...lines];
  }

  private hint(facts: DialogQuestion): string {
    const keys = facts.multiSelect
      ? ['↑↓ move', 'Space check', 'Enter submit']
      : ['↑↓ move', 'Enter select'];

    if (this.questions.length > 1) {
      keys.push('Tab switch question');
    }

    keys.push('Esc cancel');

    return keys.join(' • ');
  }
}

export const questionDialog =
  (questions: DialogQuestion[]) =>
  (terminal: TUI, theme: Theme, _keybindings: unknown, done: (result: DialogResult) => void) =>
    new QuestionDialog(questions, theme, terminal, done);
