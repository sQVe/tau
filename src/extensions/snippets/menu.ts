import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';

import { isBottom, isDown, isTop, isUp } from '../../keys/index.js';
import type { Snippet } from './types.js';

// Lines render() always emits: two borders, the title, the search line, a blank, the hints.
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
  working: Set<string>;
}

interface Groups {
  prepends: Snippet[];
  appends: Snippet[];
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
  private mode: 'list' | 'search' | 'preview' = 'list';
  private cursor = 0;
  private listScroll = 0;
  private previewScroll = 0;

  private readonly model: MenuModel;
  private readonly theme: MenuTheme;
  private readonly terminal: TUI;
  private readonly done: (result: boolean) => void;
  private readonly query = new Input({ prompt: ' / ' });

  constructor(model: MenuModel, theme: MenuTheme, terminal: TUI, done: (result: boolean) => void) {
    this.model = model;
    this.theme = theme;
    this.terminal = terminal;
    this.done = done;

    this.query.onSubmit = () => {
      this.leaveSearch();
    };

    this.query.onEscape = () => {
      this.leaveSearch();
    };
  }

  private leaveSearch(): void {
    this.mode = 'list';
    this.query.focused = false;
  }

  // Filter each group separately so matches keep their placement headers.
  private groups(): Groups {
    const text = this.query.getValue();

    const match = (snippets: Snippet[]) =>
      fuzzyFilter(snippets, text, (snippet) => `${snippet.name} ${snippet.description}`);

    return { prepends: match(this.model.prepends), appends: match(this.model.appends) };
  }

  private items(): Snippet[] {
    const { prepends, appends } = this.groups();

    return [...prepends, ...appends];
  }

  private dim(text: string): string {
    return this.theme.fg('dim', text);
  }

  private itemAt(index: number): Snippet {
    const items = this.items();
    const snippet = items[index];

    if (snippet === undefined) {
      throw new Error(`No snippet at index ${index} of ${items.length}`);
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
    const { prepends, appends } = this.groups();

    if (prepends.length === 0 && appends.length === 0) {
      return [{ text: this.header('  No matching snippets', width), itemIndex: null }];
    }

    const group = (title: string, snippets: Snippet[], offset: number): ListRow[] =>
      snippets.length === 0
        ? []
        : [
            { text: this.header(title, width), itemIndex: null },
            ...snippets.map((snippet, index) => ({
              text: this.itemRow(snippet, offset + index, width),
              itemIndex: offset + index,
            })),
          ];

    const prependRows = group('↑ PREPEND - added before your message', prepends, 0);
    const appendRows = group('↓ APPEND - added after your message', appends, prepends.length);

    const gap =
      prependRows.length > 0 && appendRows.length > 0 ? [{ text: '', itemIndex: null }] : [];

    return [...prependRows, ...gap, ...appendRows];
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
    const searchLine = truncateToWidth(this.query.render(width)[0] ?? '', width);

    if (this.mode === 'search') {
      return {
        content: view.lines,
        title: 'Prompt snippets',
        subtitle: searchLine,
        hints: 'type to filter • Enter/Esc done',
      };
    }

    const filtered = this.query.getValue() !== '';

    return {
      content: view.lines,
      title: 'Prompt snippets',
      subtitle: filtered ? searchLine : '',
      hints: `j/k move • g/G ends • Space toggle • Tab preview • / search • Enter apply • Esc ${filtered ? 'clear' : 'cancel'}`,
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
      subtitle: '',
      hints: 'j/k or ↑↓ scroll • g/G or Home/End • Tab/Esc back',
    };
  }

  private handleSearchInput(data: string): void {
    const before = this.query.getValue();

    this.query.handleInput(data);

    if (this.query.getValue() !== before) {
      this.cursor = 0;
    }

    this.terminal.requestRender();
  }

  private handleListInput(data: string): void {
    const count = this.items().length;

    if (matchesKey(data, Key.enter)) {
      this.done(true);

      return;
    }

    if (matchesKey(data, Key.escape)) {
      if (this.query.getValue() === '') {
        this.done(false);

        return;
      }

      this.query.setValue('');
      this.cursor = 0;
    } else if (matchesKey(data, '/')) {
      this.mode = 'search';
      this.query.focused = true;
    } else if (count === 0) {
      // Nothing to move to, toggle, or preview until the filter changes.
    } else if (isUp(data)) {
      this.cursor = (this.cursor - 1 + count) % count;
    } else if (isDown(data)) {
      this.cursor = (this.cursor + 1) % count;
    } else if (isTop(data)) {
      this.cursor = 0;
    } else if (isBottom(data)) {
      this.cursor = count - 1;
    } else if (matchesKey(data, Key.space)) {
      this.toggle(this.itemAt(this.cursor).id);
    } else if (matchesKey(data, Key.tab)) {
      this.mode = 'preview';
      this.previewScroll = 0;
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

    const { content, title, subtitle, hints } =
      this.mode === 'preview'
        ? this.renderPreview(width, maximumHeight)
        : this.renderList(width, maximumHeight);

    return [
      this.theme.fg('accent', '─'.repeat(width)),
      truncateToWidth(` ${this.theme.fg('accent', this.theme.bold(title))}`, width),
      subtitle,
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
    } else if (this.mode === 'search') {
      this.handleSearchInput(data);
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
  const model: MenuModel = { prepends, appends, working };

  // Pi resolves this to undefined when no component ran, which counts as a cancel.
  const confirmed = await context.ui.custom<boolean | undefined>(
    (terminal, theme, _keybindings, done) => new SnippetMenuComponent(model, theme, terminal, done),
  );

  return confirmed === true ? working : null;
};
