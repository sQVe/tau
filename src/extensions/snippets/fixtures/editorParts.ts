import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext['getEditorComponent']>>;

/** The arguments Pi passes to an editor factory, without a real terminal. */
export const editorParts = (): Parameters<EditorFactory> => {
  const keybindings = new KeybindingsManager(
    TUI_KEYBINDINGS,
  ) as unknown as Parameters<EditorFactory>[2];

  const terminalUI = {
    requestRender: () => {},
    getKeybindings: () => keybindings,
    terminal: { rows: 40, columns: 80 },
  } as unknown as TUI;

  const editorTheme: Parameters<EditorFactory>[1] = {
    borderColor: (text: string) => text,
    selectList: {
      selectedPrefix: (text: string) => text,
      selectedText: (text: string) => text,
      description: (text: string) => text,
      scrollInfo: (text: string) => text,
      noMatch: (text: string) => text,
    },
  };

  return [terminalUI, editorTheme, keybindings];
};
