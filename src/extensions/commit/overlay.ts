// Decision: ignore keybindings, as ecosystem overlays do. User escape rebinds do not apply.
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { DynamicBorder } from '@mariozechner/pi-coding-agent';
import { Container, Key, matchesKey, SelectList, Spacer, Text } from '@mariozechner/pi-tui';

export type CommitChoice = 'approve' | 'subject' | 'body' | 'skip' | 'abort';

export interface CommitView {
  subject: string;
  body: string | null;
  files: { path: string; added: string; removed: string }[];
  group?: string;
  notice?: string;
}

// Overlays neither scroll nor clip; cap both free-form sections so the choices always fit.
const MAX_BODY_LINES = 10;
const MAX_FILE_ROWS = 15;

export const confirmCommitOverlay = async (
  ctx: ExtensionContext,
  view: CommitView,
  signal?: AbortSignal,
): Promise<CommitChoice> => {
  if (signal?.aborted) {
    return 'abort';
  }
  const options = {
    overlay: true,
    overlayOptions: {
      anchor: 'center',
      width: '80%',
      maxWidth: 100,
      minWidth: 40,
      maxHeight: '90%',
    },
  } as const;
  const choice = await ctx.ui.custom<CommitChoice | undefined>((tui, theme, _keybindings, done) => {
    const onAbort = () => {
      done('abort');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const container = new Container();
    container.addChild(new DynamicBorder((text) => theme.fg('accent', text)));
    container.addChild(
      new Text(theme.fg('accent', `commit${view.group ? ` ${view.group}` : ''}`), 1, 0),
    );
    container.addChild(new Text(theme.fg('accent', theme.bold(view.subject)), 1, 0));
    const bodyLines = view.body?.length ? view.body.split('\n') : [];
    container.addChild(
      new Text(
        bodyLines.length
          ? bodyLines.slice(0, MAX_BODY_LINES).join('\n')
          : theme.fg('dim', '(no body)'),
        1,
        0,
      ),
    );
    if (bodyLines.length > MAX_BODY_LINES) {
      container.addChild(
        new Text(theme.fg('dim', `… ${bodyLines.length - MAX_BODY_LINES} more lines`), 1, 0),
      );
    }
    if (view.notice) {
      container.addChild(new Text(theme.fg('warning', view.notice), 1, 0));
    }
    container.addChild(new Spacer());
    container.addChild(new Text(theme.fg('dim', 'Files'), 1, 0));
    for (const file of view.files.slice(0, MAX_FILE_ROWS)) {
      const stat =
        file.added === '-' && file.removed === '-'
          ? theme.fg('dim', 'binary')
          : `${theme.fg('success', `+${file.added}`)} ${theme.fg('error', `-${file.removed}`)}`;
      container.addChild(new Text(`${file.path} ${stat}`, 1, 0));
    }
    if (view.files.length > MAX_FILE_ROWS) {
      container.addChild(
        new Text(theme.fg('dim', `… ${view.files.length - MAX_FILE_ROWS} more files`), 1, 0),
      );
    }
    const added = view.files.reduce((sum, file) => sum + (Number(file.added) || 0), 0);
    const removed = view.files.reduce((sum, file) => sum + (Number(file.removed) || 0), 0);
    container.addChild(new Text(theme.fg('dim', `Total: +${added} -${removed}`), 1, 0));
    container.addChild(new Spacer());
    const items: { value: CommitChoice; label: string }[] = [
      { value: 'approve', label: 'a    Approve and commit' },
      { value: 'subject', label: 's    Edit subject' },
      { value: 'body', label: 'b    Edit body' },
      { value: 'skip', label: 'k    Skip this group' },
      { value: 'abort', label: 'esc  Abort' },
    ];
    const list = new SelectList(items, 5, {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', text),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('dim', text),
      noMatch: (text) => theme.fg('warning', text),
    });
    list.onSelect = (item) => {
      done(items.find((option) => option.value === item.value)?.value);
    };
    list.onCancel = () => {
      done('abort');
    };
    container.addChild(list);
    container.addChild(new DynamicBorder((text) => theme.fg('accent', text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => {
        container.invalidate();
      },
      dispose: () => {
        signal?.removeEventListener('abort', onAbort);
      },
      handleInput(data) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
          done('abort');
          return;
        }
        const shortcuts: Record<string, CommitChoice> = {
          a: 'approve',
          s: 'subject',
          b: 'body',
          k: 'skip',
        };
        const shortcut = Object.hasOwn(shortcuts, data) ? shortcuts[data] : undefined;
        if (shortcut) {
          done(shortcut);
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  }, options);
  return choice ?? 'abort';
};
