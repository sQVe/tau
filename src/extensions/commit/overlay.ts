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

import { isBottom, isDown, isTop, isUp, toCursorKey } from '../../keys/index.js';

export type CommitChoice =
  | 'approve'
  | 'approveAll'
  | 'subject'
  | 'body'
  | 'skip'
  | 'abort'
  | 'waive'
  | 'review'
  | 'retry'
  | 'files';

export interface CommitView {
  subject: string;
  body: string | null;
  files: { path: string; added: string; removed: string }[];
  group?: string;
  notice?: string;
  review?: string;
  reviewBlocked?: boolean;
  allowApproveAll?: boolean;
  preparationAddedFiles?: string[];
  repositoryRelative?: boolean;
}

// Overlays do not scroll; cap body and file rows to leave room for choices.
const maximumBodyLines = 10;
const maximumFileRows = 15;
const fixedRows = 15;

const sectionCaps = (terminalRows: number) => {
  const budget = Math.max(6, Math.floor(terminalRows * 0.9) - fixedRows);
  const bodyLines = Math.min(maximumBodyLines, Math.floor(budget / 2));

  return { bodyLines, fileRows: Math.min(maximumFileRows, budget - bodyLines) };
};

const showCommitText = async (
  context: ExtensionContext,
  title: string,
  report: string,
  signal?: AbortSignal,
  assignment = false,
) => {
  if (signal?.aborted) {
    return 'abort';
  }

  return context.ui.custom<'return' | 'abort' | 'assign' | 'decline'>(
    (terminalInterface, theme, _keybindings, done) => {
      const onAbort = () => {
        done('abort');
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      let offset = 0;
      let lastOffset = 0;
      const text = new Text(report, 1, 0);

      return {
        render(width) {
          const lines = text.render(width);
          const footer = new Text(
            assignment
              ? 'a Assign all added paths to this group · d Decline · Esc cancel\nj/k or ↑/↓ scroll · g/G or Home/End'
              : 'j/k or ↑/↓ scroll · g/G or Home/End · Esc return · Ctrl+C abort',
            0,
            0,
          ).render(width);
          const heading = new Text(theme.fg('accent', title), 0, 0).render(width);
          const height = Math.max(
            1,
            Math.floor(terminalInterface.terminal.rows * 0.9) - heading.length - footer.length,
          );

          lastOffset = Math.max(0, lines.length - height);
          offset = Math.min(offset, lastOffset);

          return [...heading, ...lines.slice(offset, offset + height), ...footer];
        },
        invalidate() {
          text.invalidate();
        },
        dispose() {
          signal?.removeEventListener('abort', onAbort);
        },
        handleInput(data) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
            const choice = assignment || matchesKey(data, Key.ctrl('c')) ? 'abort' : 'return';

            done(choice);

            return;
          }

          if (assignment && (data === 'a' || data === 'd')) {
            done(data === 'a' ? 'assign' : 'decline');

            return;
          }

          if (isUp(data)) {
            offset = Math.max(0, offset - 1);
          }

          if (isDown(data)) {
            offset = Math.min(lastOffset, offset + 1);
          }

          if (isTop(data)) {
            offset = 0;
          }

          if (isBottom(data)) {
            offset = lastOffset;
          }

          terminalInterface.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: '90%', maxHeight: '90%' } },
  );
};

const displayPath = (path: string) =>
  JSON.stringify(path).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

export const confirmPreparationAssignment = (
  context: ExtensionContext,
  subject: string,
  requested: string[],
  added: string[],
  group?: string,
  signal?: AbortSignal,
) =>
  showCommitText(
    context,
    `Preparation assignment${group ? ` ${group}` : ''}`,
    [
      subject,
      'Assignment is not commit approval. Checks, review, and approval follow.',
      'Requested paths (repository-relative)',
      ...requested.map(displayPath),
      'Preparation-added paths (repository-relative)',
      ...added.map(displayPath),
    ].join('\n'),
    signal,
    true,
  );

const fileLabel = (view: CommitView, path: string) =>
  view.preparationAddedFiles
    ? `${view.preparationAddedFiles.includes(path) ? '[preparation-added]' : '[requested]'} ${displayPath(path)}`
    : path;

export const confirmCommitOverlay = async (
  context: ExtensionContext,
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
  const choice = await context.ui.custom<CommitChoice | undefined>(
    (terminalInterface, theme, _keybindings, done) => {
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

      const limits = sectionCaps(terminalInterface.terminal.rows - (view.review ? 3 : 0));
      const bodyLines = view.body?.length ? view.body.split('\n') : [];

      if (bodyLines.length === 0) {
        container.addChild(new Text(theme.fg('dim', '(no body)'), 1, 0));
      }

      for (const line of bodyLines.slice(0, limits.bodyLines)) {
        container.addChild(new TruncatedText(line, 1, 0));
      }

      if (bodyLines.length > limits.bodyLines) {
        container.addChild(
          new Text(theme.fg('dim', `… ${bodyLines.length - limits.bodyLines} more lines`), 1, 0),
        );
      }

      if (view.notice) {
        container.addChild(new Text(theme.fg('warning', view.notice), 1, 0));
      }

      container.addChild(new Spacer());
      container.addChild(
        new Text(
          theme.fg('dim', view.repositoryRelative ? 'Files (repository-relative)' : 'Files'),
          1,
          0,
        ),
      );

      for (const file of view.files.slice(0, limits.fileRows)) {
        const statistics =
          file.added === '-' && file.removed === '-'
            ? theme.fg('dim', 'binary')
            : `${theme.fg('success', `+${file.added}`)} ${theme.fg('error', `-${file.removed}`)}`;

        container.addChild(new TruncatedText(`${fileLabel(view, file.path)} ${statistics}`, 1, 0));
      }

      if (view.files.length > limits.fileRows) {
        container.addChild(
          new Text(theme.fg('dim', `… ${view.files.length - limits.fileRows} more files`), 1, 0),
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
        // Approve-all cannot waive a blocked review.
        ...(view.reviewBlocked || view.allowApproveAll === false
          ? []
          : [{ value: 'approveAll' as const, label: 'A    Approve all remaining' }]),
        ...(view.review ? [{ value: 'review' as const, label: 'r    Read comment review' }] : []),
        ...(view.preparationAddedFiles
          ? [{ value: 'files' as const, label: 'f    Read full file list' }]
          : []),
        ...(view.reviewBlocked
          ? [{ value: 'retry' as const, label: 't    Return for fixes or retry' }]
          : []),
        { value: 'subject', label: 's    Edit subject' },
        { value: 'body', label: 'b    Edit body' },
        { value: 'skip', label: 'x    Skip this group' },
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
        const selectedChoice = items.find((option) => option.value === item.value)?.value;

        done(selectedChoice);
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
              : {
                  a: 'approve' as const,
                  ...(view.allowApproveAll === false ? {} : { A: 'approveAll' as const }),
                }),
            ...(view.preparationAddedFiles ? { f: 'files' as const } : {}),
            ...(view.review ? { r: 'review' as const } : {}),
            s: 'subject',
            b: 'body',
            x: 'skip',
          };
          const shortcut = Object.hasOwn(shortcuts, data) ? shortcuts[data] : undefined;

          if (shortcut) {
            done(shortcut);

            return;
          }

          if (isTop(data)) {
            list.setSelectedIndex(0);
          } else if (isBottom(data)) {
            list.setSelectedIndex(items.length - 1);
          } else {
            list.handleInput(toCursorKey(data));
          }

          terminalInterface.requestRender();
        },
      };
    },
    options,
  );

  if ((choice === 'review' && view.review) || choice === 'files') {
    const report =
      choice === 'files'
        ? view.files.map((file) => fileLabel(view, file.path)).join('\n')
        : (view.review ?? '');
    const reviewChoice = await showCommitText(
      context,
      choice === 'files' ? 'Files (repository-relative)' : 'Comment review',
      report,
      signal,
    );

    if (reviewChoice !== 'return') {
      return 'abort';
    }

    return confirmCommitOverlay(context, view, signal);
  }

  return choice ?? 'abort';
};
