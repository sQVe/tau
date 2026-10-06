import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager as AppKeybindingsManager,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  KeybindingsManager,
  ScrollView,
  stripTerminalSequences,
  Text,
  TuiAltScreen,
  TUI_KEYBINDINGS as tuiKeybindings,
  VStack,
} from '@earendil-works/pi-tui';
import type { Component, Terminal } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';

import { confirm } from '../src/confirm.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const ignoreTerminalOperation = () => undefined;

const terminalFor = (rows: number): Terminal => ({
  rows,
  columns: 80,
  kittyProtocolActive: false,
  start: ignoreTerminalOperation,
  stop: ignoreTerminalOperation,
  drainInput: async () => undefined,
  write: ignoreTerminalOperation,
  moveBy: ignoreTerminalOperation,
  hideCursor: ignoreTerminalOperation,
  showCursor: ignoreTerminalOperation,
  clearLine: ignoreTerminalOperation,
  clearFromCursor: ignoreTerminalOperation,
  clearScreen: ignoreTerminalOperation,
  setTitle: ignoreTerminalOperation,
  setProgress: ignoreTerminalOperation,
});

const dockLayout = (editor: Container, widgetRows: number) => {
  const widget = new Text('Worker status\n'.repeat(widgetRows).trimEnd(), 0, 0);

  const dock = new VStack([
    { component: new Container(), shrink: 1, minSize: 0 },
    { component: new Text('Working', 0, 0), shrink: 1, minSize: 0 },
    { component: widget, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: new Text('Footer', 0, 0), shrink: 1, minSize: 0 },
  ]);

  const transcript = new ScrollView(new Text('Chat', 0, 0), { follow: 'end', primary: true });

  return new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
  ]);
};

const layoutContext = (
  terminal: Terminal,
  widgetRows: number,
  interact: (screen: TuiAltScreen, sendInput: (data: string) => void, component: Component) => void,
): ExtensionContext => {
  const custom: ExtensionUIContext['custom'] = async (factory, options) => {
    const screen = new TuiAltScreen(terminal);
    const editor = new Container();
    let sendInput: (data: string) => void = ignoreTerminalOperation;
    let result;

    terminal.start = (onInput) => {
      sendInput = onInput;
    };

    editor.addChild(new Text('Editor', 0, 0));
    screen.setLayoutRoot(dockLayout(editor, widgetRows));

    const keybindings = new KeybindingsManager(tuiKeybindings);

    const component = await factory(
      screen,
      theme,
      keybindings as unknown as AppKeybindingsManager,
      (value) => {
        result = value;
      },
    );

    if (options?.overlay === true) {
      const overlayOptions = options.overlayOptions;
      const resolved = typeof overlayOptions === 'function' ? overlayOptions() : overlayOptions;

      screen.showOverlay(component, resolved);
    } else {
      editor.clear();
      editor.addChild(component);
      screen.setFocus(component);
    }

    screen.start();

    try {
      interact(screen, sendInput, component);
    } finally {
      screen.stop();
    }

    return result as never;
  };

  return { mode: 'tui', hasUI: true, ui: { custom } } as unknown as ExtensionContext;
};

it.each([
  { rows: 12, widgetRows: 6 },
  { rows: 24, widgetRows: 6 },
  { rows: 12, widgetRows: 12 },
  { rows: 24, widgetRows: 12 },
])(
  'keeps confirmation controls visible with $widgetRows widget rows in a $rows-row screen',
  async ({ rows, widgetRows }) => {
    const pages: { visible: string[]; dialog: string[] }[] = [];
    const terminal = terminalFor(rows);

    const context = layoutContext(terminal, widgetRows, (screen, sendInput, component) => {
      screen.renderNow();

      pages.push({
        visible: screen.getScreenLines().map(stripTerminalSequences),
        dialog: component.render(terminal.columns),
      });

      for (let index = 0; index < 40; index += 1) {
        sendInput('\u001B[6~');
        screen.renderNow();
      }

      pages.push({
        visible: screen.getScreenLines().map(stripTerminalSequences),
        dialog: component.render(terminal.columns),
      });

      sendInput('\r');
    });

    const message = Array.from({ length: 40 }, (_, index) => `Write ${index + 1}`).join('\n');

    expect(await confirm(context, 'Review writes', message)).toBe(true);

    for (const page of pages) {
      const visible = page.visible.join('\n');
      const visibleRows = page.visible.map((line) => line.trimEnd());
      const dialogRows = page.dialog.map((line) => line.trimEnd());

      expect(page.visible).toHaveLength(rows);
      expect(visible).toContain('Review writes');
      expect(visible).toContain('→ Yes');
      expect(visible).toContain('No');
      expect(visibleRows).toEqual(expect.arrayContaining(dialogRows));
    }

    expect(pages[0]?.visible.join('\n')).toContain('Write 1');
    expect(pages[0]?.visible.join('\n')).not.toContain('Write 40');
    expect(pages[1]?.visible.join('\n')).toContain('Write 40');
  },
);
