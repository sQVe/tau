import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';

import type { Snippet } from './types.js';

// Lines the frame spends on borders, title, padding, and hints.
const frameHeight = 10;
const minimumViewHeight = 5;

interface ListRow {
  text: string;
  itemIndex: number | null;
}

interface Viewport {
  lines: string[];
  scroll: number;
}

/**
 * Clips `lines` to at most `maxHeight` lines. When clipped, two lines are spent
 * on the "n more" indicators. A `focusRow` is scrolled into view.
 */
const clipToViewport = (
  lines: string[],
  scroll: number,
  maxHeight: number,
  indicator: (text: string) => string,
  focusRow?: number,
): Viewport => {
  if (lines.length <= maxHeight) {
    return { lines, scroll: 0 };
  }

  const height = Math.max(1, maxHeight - 2);
  let position = Math.min(Math.max(0, scroll), lines.length - height);
  if (focusRow !== undefined) {
    if (focusRow < position) {
      position = focusRow;
    } else if (focusRow >= position + height) {
      position = focusRow - height + 1;
    }
  }

  const above = position;
  const below = lines.length - (position + height);

  return {
    lines: [
      above > 0 ? indicator(`  ↑ ${above} more`) : '',
      ...lines.slice(position, position + height),
      below > 0 ? indicator(`  ↓ ${below} more`) : '',
    ],
    scroll: position,
  };
};

/**
 * Shows the snippet toggle menu. Resolves to the selected ids, or to null when
 * the user cancels.
 */
export const openSnippetMenu = async (
  ctx: ExtensionContext,
  snippets: Snippet[],
  enabled: ReadonlySet<string>,
): Promise<Set<string> | null> => {
  const working = new Set(enabled);
  const prepends = snippets.filter((snippet) => snippet.placement === 'prepend');
  const appends = snippets.filter((snippet) => snippet.placement === 'append');
  const items = [...prepends, ...appends];

  const itemAt = (index: number): Snippet => {
    const snippet = items[index];
    if (snippet === undefined) {
      throw new Error(`No snippet at index ${index} of ${items.length}`);
    }

    return snippet;
  };

  const confirmed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
    let mode: 'list' | 'preview' = 'list';
    let cursor = 0;
    let listScroll = 0;
    let previewScroll = 0;

    const dim = (text: string) => theme.fg('dim', text);

    const itemRow = (snippet: Snippet, index: number, width: number) => {
      const pointer = index === cursor ? theme.fg('accent', '> ') : '  ';
      const checkbox = working.has(snippet.id) ? theme.fg('success', '[x]') : dim('[ ]');
      const description = snippet.description === '' ? '' : dim(` - ${snippet.description}`);

      return truncateToWidth(
        `${pointer}${checkbox} ${theme.bold(snippet.name)}${description}`,
        width,
      );
    };

    const buildListRows = (width: number): ListRow[] => [
      { text: dim('↑ PREPEND - added before your message'), itemIndex: null },
      ...prepends.map((snippet, index) => ({
        text: itemRow(snippet, index, width),
        itemIndex: index,
      })),
      { text: '', itemIndex: null },
      { text: dim('↓ APPEND - added after your message'), itemIndex: null },
      ...appends.map((snippet, index) => ({
        text: itemRow(snippet, prepends.length + index, width),
        itemIndex: prepends.length + index,
      })),
    ];

    const buildPreviewRows = (snippet: Snippet, width: number) => [
      truncateToWidth(theme.bold(snippet.name), width),
      truncateToWidth(dim(`${snippet.placement} - order ${snippet.order} - ${snippet.id}`), width),
      dim('─'.repeat(Math.min(width, 40))),
      ...snippet.body
        .split('\n')
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .map((line) => truncateToWidth(line, width)),
    ];

    const renderList = (width: number, maxHeight: number) => {
      const rows = buildListRows(width);
      const view = clipToViewport(
        rows.map((row) => row.text),
        listScroll,
        maxHeight,
        dim,
        rows.findIndex((row) => row.itemIndex === cursor),
      );
      listScroll = view.scroll;

      return {
        content: view.lines,
        title: 'Prompt snippets',
        hints: '↑↓ navigate • Space toggle • Tab preview • Enter apply • Esc cancel',
      };
    };

    const renderPreview = (width: number, maxHeight: number) => {
      const snippet = itemAt(cursor);
      const view = clipToViewport(buildPreviewRows(snippet, width), previewScroll, maxHeight, dim);
      previewScroll = view.scroll;

      return {
        content: view.lines,
        title: `Preview: ${snippet.name}`,
        hints: '↑↓ scroll • Tab/Esc back',
      };
    };

    const handleListInput = (data: string) => {
      if (matchesKey(data, Key.up)) {
        cursor = (cursor - 1 + items.length) % items.length;
      } else if (matchesKey(data, Key.down)) {
        cursor = (cursor + 1) % items.length;
      } else if (matchesKey(data, Key.space)) {
        const { id } = itemAt(cursor);
        if (working.has(id)) {
          working.delete(id);
        } else {
          working.add(id);
        }
      } else if (matchesKey(data, Key.tab)) {
        mode = 'preview';
        previewScroll = 0;
      } else if (matchesKey(data, Key.enter)) {
        done(true);
        return;
      } else if (matchesKey(data, Key.escape)) {
        done(false);
        return;
      }

      tui.requestRender();
    };

    const handlePreviewInput = (data: string) => {
      if (matchesKey(data, Key.up)) {
        previewScroll -= 1;
      } else if (matchesKey(data, Key.down)) {
        previewScroll += 1;
      } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
        mode = 'list';
      }

      tui.requestRender();
    };

    return {
      render(width: number) {
        const maxHeight = Math.max(minimumViewHeight, tui.terminal.rows - frameHeight);
        const { content, title, hints } =
          mode === 'list' ? renderList(width, maxHeight) : renderPreview(width, maxHeight);

        return [
          theme.fg('accent', '─'.repeat(width)),
          truncateToWidth(` ${theme.fg('accent', theme.bold(title))}`, width),
          '',
          ...content,
          '',
          truncateToWidth(dim(` ${hints}`), width),
          theme.fg('accent', '─'.repeat(width)),
        ];
      },
      invalidate() {
        // Rendering reads current state directly, so there is nothing to reset.
      },
      handleInput(data: string) {
        if (mode === 'list') {
          handleListInput(data);
        } else {
          handlePreviewInput(data);
        }
      },
    };
  });

  return confirmed ? working : null;
};
