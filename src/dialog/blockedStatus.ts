import type { ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, ProgramStatus, TUI } from '@earendil-works/pi-tui';

interface BlockedFacts {
  kind: 'permission' | 'question';
  message: string;
}

type Dialog = Component & { dispose?: () => void };

type DialogFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => Dialog | Promise<Dialog>;

const programName = 'pi';

let openDialogs = 0;

const reportWorking = (tui: TUI, context: ExtensionContext): void => {
  const sessionName = context.sessionManager.getSessionName();

  const status: ProgramStatus = {
    state: 'working',
    app: programName,
    ...(sessionName === undefined ? {} : { message: sessionName }),
  };

  tui.terminal.setProgramStatus(status);
};

// Remove this shim once Pi reports blocked for ctx.ui.custom dialogs.
export const customWithBlockedStatus = async <T>(
  context: ExtensionContext,
  blocked: BlockedFacts,
  factory: DialogFactory<T>,
  options?: Parameters<ExtensionContext['ui']['custom']>[1],
): Promise<T> => {
  let openedTui: TUI | undefined;

  const wrappedFactory: DialogFactory<T> = (tui, theme, keybindings, done) => {
    openedTui = tui;

    if (openDialogs === 0) {
      tui.terminal.setProgramStatus({
        state: 'blocked',
        app: programName,
        kind: blocked.kind,
        message: blocked.message,
      });
    }

    openDialogs += 1;

    return factory(tui, theme, keybindings, done);
  };

  try {
    return await context.ui.custom<T>(wrappedFactory, options);
  } finally {
    if (openedTui !== undefined) {
      openDialogs -= 1;

      if (openDialogs === 0) {
        reportWorking(openedTui, context);
      }
    }
  }
};
