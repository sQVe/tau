import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Key,
  matchesKey,
  SelectList,
  Spacer,
  Text,
  TruncatedText,
} from '@earendil-works/pi-tui';

export type CommitChoice =
  | 'approve'
  | 'approveAll'
  | 'subject'
  | 'body'
  | 'skip'
  | 'abort'
  | 'waive'
  | 'review'
  | 'retry';

export interface CommitView {
  subject: string;
  body: string | null;
  files: { path: string; added: string; removed: string }[];
  group?: string;
  notice?: string;
  review?: string;
  reviewBlocked?: boolean;
}

// Overlays do not scroll; cap body and file rows to leave room for choices.
const MAX_BODY_LINES = 10;
const MAX_FILE_ROWS = 15;
const FIXED_ROWS = 15;

const sectionCaps = (terminalRows: number) => {
  const budget = Math.max(6, Math.floor(terminalRows * 0.9) - FIXED_ROWS);
  const bodyLines = Math.min(MAX_BODY_LINES, Math.floor(budget / 2));
  return { bodyLines, fileRows: Math.min(MAX_FILE_ROWS, budget - bodyLines) };
};

const showCommentReview = async (ctx: ExtensionContext, report: string, signal?: AbortSignal) => {
  if (signal?.aborted) return 'abort';
  return ctx.ui.custom<'return' | 'abort'>(
    (tui, theme, _keybindings, done) => {
      let offset = 0;
      let lastOffset = 0;
      const onAbort = () => {
        done('abort');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const text = new Text(report, 1, 0);
      return {
        render(width) {
          const lines = text.render(width);
          const height = Math.max(1, Math.floor(tui.terminal.rows * 0.9) - 3);
          lastOffset = Math.max(0, lines.length - height);
          offset = Math.min(offset, lastOffset);
          return [
            theme.fg('accent', 'Comment review'),
            ...lines.slice(offset, offset + height),
            theme.fg('dim', '↑/↓ scroll · Home/End · Esc return · Ctrl+C abort'),
          ];
        },
        invalidate() {
          text.invalidate();
        },
        dispose() {
          signal?.removeEventListener('abort', onAbort);
        },
        handleInput(data) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
            done(matchesKey(data, Key.ctrl('c')) ? 'abort' : 'return');
            return;
          }
          if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
          if (matchesKey(data, Key.down)) offset = Math.min(lastOffset, offset + 1);
          if (matchesKey(data, Key.home)) offset = 0;
          if (matchesKey(data, Key.end)) offset = lastOffset;
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: '90%', maxHeight: '90%' } },
  );
};

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
    const caps = sectionCaps(tui.terminal.rows - (view.review ? 3 : 0));
    const bodyLines = view.body?.length ? view.body.split('\n') : [];
    if (bodyLines.length === 0) {
      container.addChild(new Text(theme.fg('dim', '(no body)'), 1, 0));
    }
    for (const line of bodyLines.slice(0, caps.bodyLines)) {
      container.addChild(new TruncatedText(line, 1, 0));
    }
    if (bodyLines.length > caps.bodyLines) {
      container.addChild(
        new Text(theme.fg('dim', `… ${bodyLines.length - caps.bodyLines} more lines`), 1, 0),
      );
    }
    if (view.notice) {
      container.addChild(new Text(theme.fg('warning', view.notice), 1, 0));
    }
    container.addChild(new Spacer());
    container.addChild(new Text(theme.fg('dim', 'Files'), 1, 0));
    for (const file of view.files.slice(0, caps.fileRows)) {
      const stat =
        file.added === '-' && file.removed === '-'
          ? theme.fg('dim', 'binary')
          : `${theme.fg('success', `+${file.added}`)} ${theme.fg('error', `-${file.removed}`)}`;
      container.addChild(new TruncatedText(`${file.path} ${stat}`, 1, 0));
    }
    if (view.files.length > caps.fileRows) {
      container.addChild(
        new Text(theme.fg('dim', `… ${view.files.length - caps.fileRows} more files`), 1, 0),
      );
    }
    const added = view.files.reduce((sum, file) => sum + (Number(file.added) || 0), 0);
    const removed = view.files.reduce((sum, file) => sum + (Number(file.removed) || 0), 0);
    container.addChild(new Text(theme.fg('dim', `Total: +${added} -${removed}`), 1, 0));
    container.addChild(new Spacer());
    if (view.review) {
      container.addChild(
        new TruncatedText(theme.fg('warning', view.review.split('\n')[0] ?? ''), 1, 0),
      );
    }
    const items: { value: CommitChoice; label: string }[] = [
      view.reviewBlocked
        ? { value: 'waive', label: 'w    Waive comment review and commit' }
        : { value: 'approve', label: 'a    Approve and commit' },
      { value: 'approveAll', label: 'A    Approve all remaining' },
      ...(view.review ? [{ value: 'review' as const, label: 'r    Read comment review' }] : []),
      ...(view.reviewBlocked
        ? [{ value: 'retry' as const, label: 't    Return for fixes or retry' }]
        : []),
      { value: 'subject', label: 's    Edit subject' },
      { value: 'body', label: 'b    Edit body' },
      { value: 'skip', label: 'k    Skip this group' },
      { value: 'abort', label: 'esc  Abort' },
    ];
    const list = new SelectList(items, items.length, {
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
        // Escape and Ctrl+C stay fixed regardless of user keybindings.
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
          done('abort');
          return;
        }
        const shortcuts: Record<string, CommitChoice> = {
          ...(view.reviewBlocked
            ? { w: 'waive' as const, t: 'retry' as const }
            : { a: 'approve' as const }),
          ...(view.review ? { r: 'review' as const } : {}),
          A: 'approveAll',
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
  if (choice === 'review' && view.review) {
    if ((await showCommentReview(ctx, view.review, signal)) !== 'return') return 'abort';
    return confirmCommitOverlay(ctx, view, signal);
  }
  return choice ?? 'abort';
};
