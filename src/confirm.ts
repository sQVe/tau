import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Container, matchesKey, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';

import { isBottom, isDown, isTop, isUp } from './keys.js';

const overlayMargin = { top: 5, bottom: 1 };
const viewportChromeRows = 3;

const renderOptions = (options: Container, selected: number, theme: Theme) => {
  options.clear();

  for (const [index, label] of ['Yes', 'No'].entries()) {
    const text =
      index === selected
        ? theme.fg('accent', '→ ') + theme.fg('accent', label)
        : `  ${theme.fg('text', label)}`;

    options.addChild(new Text(text, 1, 0));
  }
};

export const confirm = async (
  context: ExtensionContext,
  title: string,
  message: string,
): Promise<boolean> => {
  if (context.mode !== 'tui') {
    return context.ui.confirm(title, message);
  }

  const answer = await context.ui.custom<boolean | undefined>(
    (terminal, theme, keybindings, done) => {
      const dialog: Container & Component = new Container();
      const options = new Container();
      const boldTitle = theme.bold(title);
      const selectKeys = keybindings.getKeys('tui.select.confirm').join('/');
      const cancelKeys = keybindings.getKeys('tui.select.cancel').join('/');

      const hint =
        theme.fg('dim', '↑↓') +
        theme.fg('muted', ' navigate  ') +
        theme.fg('dim', selectKeys) +
        theme.fg('muted', ' select  ') +
        theme.fg('dim', cancelKeys) +
        theme.fg('muted', ' cancel');

      let selected = 0;
      let offset = 0;
      let viewportRows = 1;
      const titleText = new Text(theme.fg('accent', boldTitle), 1, 0);
      const messageText = new Text(theme.fg('text', message), 1, 0);
      const renderFullDialog = dialog.render.bind(dialog);

      dialog.render = (width) => {
        // Overlay margins reserve this space independently of widgets in Pi's input dock.
        const availableRows = terminal.terminal.rows - overlayMargin.top - overlayMargin.bottom;
        const full = renderFullDialog(width);

        if (full.length <= availableRows) {
          offset = 0;

          return full;
        }

        const all = messageText.render(width);
        const titleRow = truncateToWidth(` ${theme.fg('accent', boldTitle)}`, width);
        const scrollHint = theme.fg('muted', ' PgUp/PgDn scroll  ') + hint;
        const hintRow = truncateToWidth(scrollHint, width);
        const optionRows = options.render(width);

        viewportRows = Math.max(1, availableRows - optionRows.length - viewportChromeRows);
        offset = Math.min(offset, Math.max(0, all.length - viewportRows));

        const shown = all.slice(offset, offset + viewportRows);
        const position = ` lines ${offset + 1}-${offset + shown.length} of ${all.length}`;
        const positionRow = truncateToWidth(theme.fg('muted', position), width);

        return [titleRow, ...shown, positionRow, ...optionRows, hintRow];
      };

      const scrollMessage = (data: string): boolean => {
        if (matchesKey(data, 'pageUp')) {
          offset = Math.max(0, offset - viewportRows);
        } else if (matchesKey(data, 'pageDown')) {
          offset += viewportRows;
        } else {
          return false;
        }

        terminal.requestRender();

        return true;
      };

      dialog.addChild(new DynamicBorder((text) => theme.fg('border', text)));
      dialog.addChild(new Spacer(1));
      dialog.addChild(titleText);
      dialog.addChild(new Spacer(1));
      dialog.addChild(messageText);
      dialog.addChild(new Spacer(1));
      dialog.addChild(options);
      dialog.addChild(new Spacer(1));
      dialog.addChild(new Text(hint, 1, 0));
      dialog.addChild(new Spacer(1));
      dialog.addChild(new DynamicBorder((text) => theme.fg('border', text)));
      renderOptions(options, selected, theme);

      dialog.handleInput = (data) => {
        if (scrollMessage(data)) {
          return;
        }

        if (keybindings.matches(data, 'app.tools.expand')) {
          context.ui.setToolsExpanded(!context.ui.getToolsExpanded());
        } else if (keybindings.matches(data, 'tui.select.up') || isUp(data)) {
          selected = Math.max(0, selected - 1);
        } else if (keybindings.matches(data, 'tui.select.down') || isDown(data)) {
          selected = Math.min(1, selected + 1);
        } else if (isTop(data)) {
          selected = 0;
        } else if (isBottom(data)) {
          selected = 1;
        } else if (keybindings.matches(data, 'tui.select.confirm') || data === '\n') {
          done(selected === 0);

          return;
        } else if (keybindings.matches(data, 'tui.select.cancel')) {
          done(false);

          return;
        }

        renderOptions(options, selected, theme);
        terminal.requestRender();
      };

      return dialog;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: 'bottom-center',
        width: '100%',
        maxHeight: '100%',
        margin: overlayMargin,
      },
    },
  );

  return answer ?? false;
};
