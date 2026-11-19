import type { HerdrSpace } from './herdrPane.js';

export interface Foreground {
  name: string;
  cwd: string;
}

const shellNames = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);

const onlyItem = <Item>(items: readonly Item[]): Item | undefined =>
  items.length === 1 ? items[0] : undefined;

const hasApp = (app: string | null | undefined): boolean => app !== null && app !== undefined;

export const soleShellPane = (
  space: HerdrSpace | undefined,
): { terminal: string; pane: string } | undefined => {
  const tab = space === undefined ? undefined : onlyItem(space.tabs);
  const terminal = tab === undefined ? undefined : onlyItem(tab.terminals);
  const pane = terminal?.pane;

  if (terminal === undefined) {
    return undefined;
  }

  const hasNoPane = pane === undefined || pane === null || pane === '';
  const unusable = hasApp(terminal.app) || hasNoPane;

  return unusable ? undefined : { terminal: terminal.terminal, pane };
};

export const isIdleShell = (foreground: Foreground | null | undefined, folder: string): boolean => {
  if (foreground === null || foreground === undefined) {
    return false;
  }

  return shellNames.has(foreground.name) && foreground.cwd === folder;
};
