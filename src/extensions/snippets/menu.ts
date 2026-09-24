import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';

import { isBottom, isDown, isTop, isUp } from '../../keys/index.js';
import type { Snippet } from './types.js';

// Lines render() always emits: two borders, the title, two blanks, the hints.
const chromeHeight = 6;
// Chrome plus room for the editor below, when the terminal is tall enough.
const frameHeight = 10;
const minimumViewHeight = 5;

type MenuTheme = Pick<Theme, 'fg' | 'bold'>;

interface ListRow {
  text: string;
  itemIndex: number | null;
}

interface Viewport {
  lines: string[];
  scroll: number;
}

interface ViewportRequest {
  lines: string[];
  scroll: number;
  maximumHeight: number;
  indicator: (text: string) => string;
  focusRow?: number;
}

interface MenuModel {
  prepends: Snippet[];
  appends: Snippet[];
  items: Snippet[];
  working: Set<string>;
}

/**
 * Clips `lines` to at most `maximumHeight` lines and scrolls `focusRow` into view.
 * Indicators use two rows when there is room for at least one content row.
 */
const clipToViewport = (request: ViewportRequest): Viewport => {
  const { lines, maximumHeight, indicator, focusRow } = request;

  if (lines.length <= maximumHeight) {
    return { lines, scroll: 0 };
  }

  const showIndicators = maximumHeight >= 3;
  const height = showIndicators ? maximumHeight - 2 : maximumHeight;
  let position = Math.min(Math.max(0, request.scroll), lines.length - height);

  if (focusRow !== undefined) {
    if (focusRow < position) {
      position = focusRow;
    } else if (focusRow >= position + height) {
      position = focusRow - height + 1;
    }
  }

  const above = position;
  const below = lines.length - (position + height);
  const visible = lines.slice(position, position + height);

  return {
    lines: showIndicators
      ? [
          above > 0 ? indicator(`  ↑ ${above} more`) : '',
          ...visible,
          below > 0 ? indicator(`  ↓ ${below} more`) : '',
        ]
      : visible,
    scroll: position,
  };
};

class SnippetMenuComponent implements Component {
  private mode: 'list' | 'preview' = 'list';
  private cursor = 0;
  private listScroll = 0;
  private previewScroll = 0;

  private readonly model: MenuModel;
  private readonly theme: MenuTheme;
  private readonly terminal: TUI;
  private readonly done: (result: boolean) => void;

  constructor(model: MenuModel, theme: MenuTheme, terminal: TUI, done: (result: boolean) => void) {
    this.model = model;
    this.theme = theme;
    this.terminal = terminal;
    this.done = done;
  }

  private dim(text: string): string {
    return this.theme.fg('dim', text);
  }

  private itemAt(index: number): Snippet {
    const snippet = this.model.items[index];

    if (snippet === undefined) {
      throw new Error(`No snippet at index ${index} of ${this.model.items.length}`);
    }

    return snippet;
  }

  private itemRow(snippet: Snippet, index: number, width: number): string {
    const pointer = index === this.cursor ? this.theme.fg('accent', '> ') : '  ';
    const checkbox = this.model.working.has(snippet.id)
      ? this.theme.fg('success', '[x]')
      : this.dim('[ ]');
    const description = snippet.description === '' ? '' : this.dim(` - ${snippet.description}`);

    return truncateToWidth(
      `${pointer}${checkbox} ${this.theme.bold(snippet.name)}${description}`,
      width,
    );
  }

  // Every row must be truncated, or a narrow terminal wraps it and the frame
  // grows a line past the height render() reported.
  private header(text: string, width: number): string {
    return truncateToWidth(this.dim(text), width);
  }

  private buildListRows(width: number): ListRow[] {
    return [
      {
        text: this.header('↑ PREPEND - added before your message', width),
        itemIndex: null,
      },
      ...this.model.prepends.map((snippet, index) => ({
        text: this.itemRow(snippet, index, width),
        itemIndex: index,
      })),
      { text: '', itemIndex: null },
      {
        text: this.header('↓ APPEND - added after your message', width),
        itemIndex: null,
      },
      ...this.model.appends.map((snippet, index) => ({
        text: this.itemRow(snippet, this.model.prepends.length + index, width),
        itemIndex: this.model.prepends.length + index,
      })),
    ];
  }

  private buildPreviewRows(snippet: Snippet, width: number): string[] {
    return [
      truncateToWidth(this.theme.bold(snippet.name), width),
      truncateToWidth(
        this.dim(`${snippet.placement} - order ${snippet.order} - ${snippet.id}`),
        width,
      ),
      this.dim('─'.repeat(Math.min(width, 40))),
      ...snippet.body
        .split('\n')
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .map((line) => truncateToWidth(line, width)),
    ];
  }

  private renderList(width: number, maximumHeight: number) {
    const rows = this.buildListRows(width);
    const view = clipToViewport({
      lines: rows.map((row) => row.text),
      scroll: this.listScroll,
      maximumHeight,
      indicator: (text) => this.header(text, width),
      focusRow: rows.findIndex((row) => row.itemIndex === this.cursor),
    });
    this.listScroll = view.scroll;

    return {
      content: view.lines,
      title: 'Prompt snippets',
      hints: 'j/k move • g/G ends • Space toggle • Tab preview • Enter apply • Esc cancel',
    };
  }

  private renderPreview(width: number, maximumHeight: number) {
    const snippet = this.itemAt(this.cursor);
    const view = clipToViewport({
      lines: this.buildPreviewRows(snippet, width),
      scroll: this.previewScroll,
      maximumHeight,
      indicator: (text) => this.header(text, width),
    });
    this.previewScroll = view.scroll;

    return {
      content: view.lines,
      title: `Preview: ${snippet.name}`,
      hints: 'j/k or ↑↓ scroll • g/G or Home/End • Tab/Esc back',
    };
  }

  private handleListInput(data: string): void {
    if (isUp(data)) {
      this.cursor = (this.cursor - 1 + this.model.items.length) % this.model.items.length;
    } else if (isDown(data)) {
      this.cursor = (this.cursor + 1) % this.model.items.length;
    } else if (isTop(data)) {
      this.cursor = 0;
    } else if (isBottom(data)) {
      this.cursor = this.model.items.length - 1;
    } else if (matchesKey(data, Key.space)) {
      this.toggle(this.itemAt(this.cursor).id);
    } else if (matchesKey(data, Key.tab)) {
      this.mode = 'preview';
      this.previewScroll = 0;
    } else if (matchesKey(data, Key.enter)) {
      this.done(true);

      return;
    } else if (matchesKey(data, Key.escape)) {
      this.done(false);

      return;
    }

    this.terminal.requestRender();
  }

  private toggle(id: string): void {
    if (this.model.working.has(id)) {
      this.model.working.delete(id);
    } else {
      this.model.working.add(id);
    }
  }

  private handlePreviewInput(data: string): void {
    if (isUp(data)) {
      this.previewScroll -= 1;
    } else if (isDown(data)) {
      this.previewScroll += 1;
    } else if (isTop(data)) {
      this.previewScroll = 0;
    } else if (isBottom(data)) {
      this.previewScroll = Number.MAX_SAFE_INTEGER;
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
      this.mode = 'list';
    }

    this.terminal.requestRender();
  }

  private maximumHeight(): number {
    // Keep at least one content row, even when the terminal cannot fit the frame.
    return Math.max(
      1,
      Math.min(
        this.terminal.terminal.rows - chromeHeight,
        Math.max(minimumViewHeight, this.terminal.terminal.rows - frameHeight),
      ),
    );
  }

  render(width: number): string[] {
    const maximumHeight = this.maximumHeight();
    const { content, title, hints } =
      this.mode === 'list'
        ? this.renderList(width, maximumHeight)
        : this.renderPreview(width, maximumHeight);

    return [
      this.theme.fg('accent', '─'.repeat(width)),
      truncateToWidth(` ${this.theme.fg('accent', this.theme.bold(title))}`, width),
      '',
      ...content,
      '',
      truncateToWidth(this.dim(` ${hints}`), width),
      this.theme.fg('accent', '─'.repeat(width)),
    ];
  }

  invalidate(): void {
    // Rendering reads current state directly, so there is nothing to reset.
  }

  handleInput(data: string): void {
    if (this.mode === 'list') {
      this.handleListInput(data);
    } else {
      this.handlePreviewInput(data);
    }
  }
}

/**
 * Shows the snippet toggle menu. Resolves to the selected ids, or to null when
 * the user cancels.
 */
export const openSnippetMenu = async (
  context: ExtensionContext,
  snippets: Snippet[],
  enabled: ReadonlySet<string>,
): Promise<Set<string> | null> => {
  const working = new Set(enabled);
  const prepends = snippets.filter((snippet) => snippet.placement === 'prepend');
  const appends = snippets.filter((snippet) => snippet.placement === 'append');
  const items = [...prepends, ...appends];
  const model: MenuModel = { prepends, appends, items, working };

  // Pi resolves this to undefined when no component ran, which counts as a cancel.
  const confirmed = await context.ui.custom<boolean | undefined>(
    (terminal, theme, _keybindings, done) => new SnippetMenuComponent(model, theme, terminal, done),
  );

  return confirmed === true ? working : null;
};
