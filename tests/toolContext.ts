import type {
  ExtensionToolContext,
  ExtensionUIContext,
  KeybindingsManager as AppKeybindingsManager,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS as tuiKeybindings } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';

export const customContext = (
  interact: (component: Component) => Promise<void> | void,
  theme: Theme,
  keybindings = new KeybindingsManager(tuiKeybindings),
  dimensions?: { rows: number; columns: number },
): ExtensionToolContext => {
  const custom: ExtensionUIContext['custom'] = async (factory) => {
    let result;

    const terminal = {
      requestRender: () => undefined,
      terminal: dimensions ?? { rows: 40, columns: 100 },
    } as unknown as TUI;

    const component = await factory(
      terminal,
      theme,
      keybindings as unknown as AppKeybindingsManager,
      (value) => {
        result = value;
      },
    );

    await interact(component);

    return result as never;
  };

  return { mode: 'tui', hasUI: true, ui: { custom } } as unknown as ExtensionToolContext;
};

export const confirmContext = (
  cwd: string,
  confirm: (title: string, message: string) => Promise<boolean>,
): ExtensionToolContext => {
  const colored: { color: string; text: string }[] = [];

  const theme = {
    fg: (color: string, text: string) => {
      colored.push({ color, text });

      return text;
    },
    bold: (text: string) => text,
  } as unknown as Theme;

  const context = customContext(async (component) => {
    component.render(100);

    const prompt = colored.splice(0);
    const title = prompt.find(({ color }) => color === 'accent')?.text ?? '';
    const message = prompt.find(({ color }) => color === 'text')?.text ?? '';
    const answer = await confirm(title, message);

    if (!answer) {
      component.handleInput?.('\u001B[B');
    }

    component.handleInput?.('\r');
    colored.length = 0;
  }, theme);

  return { ...context, cwd };
};

export const noUiContext = (cwd: string): ExtensionToolContext =>
  ({
    cwd,
    hasUI: false,
    ui: {},
  }) as unknown as ExtensionToolContext;
