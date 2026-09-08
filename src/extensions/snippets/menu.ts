import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { isBottom, isDown, isTop, isUp } from '../../keys/index.js';
import type { Snippet } from './types.js';

// Lines render() always emits: two borders, the title, two blanks, the hints.
const chromeHeight = 6;
// Chrome plus room for the editor below, when the terminal is tall enough.
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

  // The two indicators only earn their rows when a row is left for content.
  const showIndicators = maxHeight >= 3;
  const height = showIndicators ? maxHeight - 2 : maxHeight;
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

  // Pi resolves this to undefined when no component ran, which counts as a cancel.
  const confirmed = await ctx.ui.custom<boolean | undefined>((tui, theme, _keybindings, done) => {
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

    // Every row must be truncated, or a narrow terminal wraps it and the frame
    // grows a line past the height render() reported.
    const header = (text: string, width: number) => truncateToWidth(dim(text), width);

    const buildListRows = (width: number): ListRow[] => [
      { text: header('↑ PREPEND - added before your message', width), itemIndex: null },
      ...prepends.map((snippet, index) => ({
        text: itemRow(snippet, index, width),
        itemIndex: index,
      })),
      { text: '', itemIndex: null },
      { text: header('↓ APPEND - added after your message', width), itemIndex: null },
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
        (text) => header(text, width),
        rows.findIndex((row) => row.itemIndex === cursor),
      );
      listScroll = view.scroll;

      return {
        content: view.lines,
        title: 'Prompt snippets',
        hints: 'j/k move • g/G ends • Space toggle • Tab preview • Enter apply • Esc cancel',
      };
    };

    const renderPreview = (width: number, maxHeight: number) => {
      const snippet = itemAt(cursor);
      const view = clipToViewport(
        buildPreviewRows(snippet, width),
        previewScroll,
        maxHeight,
        (text) => header(text, width),
      );
      previewScroll = view.scroll;

      return {
        content: view.lines,
        title: `Preview: ${snippet.name}`,
        hints: 'j/k scroll • g/G ends • Tab/Esc back',
      };
    };

    const handleListInput = (data: string) => {
      if (isUp(data)) {
        cursor = (cursor - 1 + items.length) % items.length;
      } else if (isDown(data)) {
        cursor = (cursor + 1) % items.length;
      } else if (isTop(data)) {
        cursor = 0;
      } else if (isBottom(data)) {
        cursor = items.length - 1;
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
      if (isUp(data)) {
        previewScroll -= 1;
      } else if (isDown(data)) {
        previewScroll += 1;
      } else if (isTop(data)) {
        previewScroll = 0;
      } else if (isBottom(data)) {
        previewScroll = Number.MAX_SAFE_INTEGER;
      } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
        mode = 'list';
      }

      tui.requestRender();
    };

    return {
      render(width: number) {
        // Never exceed the terminal, even when that means dropping below the
        // comfortable minimum on a very short one.
        const maxHeight = Math.max(
          1,
          Math.min(
            tui.terminal.rows - chromeHeight,
            Math.max(minimumViewHeight, tui.terminal.rows - frameHeight),
          ),
        );
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

  return confirmed === true ? working : null;
};
