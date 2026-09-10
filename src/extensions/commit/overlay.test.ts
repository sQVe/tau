import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { confirmCommitOverlay, confirmPreparationAssignment } from './overlay.js';

const view = {
  subject: 'feat: add overlay',
  body: null,
  files: [
    { path: 'src/foo.ts', added: '12', removed: '3' },
    { path: 'image.png', added: '-', removed: '-' },
  ],
  group: '1/2',
};

const setup = (keys: string[], terminalRows = 60, followUps: string[][] = []) => {
  const steps = [keys, ...followUps];
  const done = vi.fn<(result: unknown) => void>();
  const render = vi.fn<(text: string) => void>();
  const custom = vi.fn<
    (
      factory: Parameters<ExtensionContext['ui']['custom']>[0],
      options?: unknown,
    ) => Promise<unknown>
  >(async (factory: Parameters<ExtensionContext['ui']['custom']>[0], _options?: unknown) => {
    const component = await factory(
      { requestRender: vi.fn<() => void>(), terminal: { rows: terminalRows } } as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      {} as never,
      done,
    );

    render(component.render(80).join('\n'));
    component.invalidate();

    for (const key of steps.shift() ?? []) {
      component.handleInput?.(key);
    }

    render(component.render(80).join('\n'));

    return done.mock.lastCall?.[0];
  });

  return { context: { ui: { custom } } as unknown as ExtensionContext, custom, done, render };
};

describe('preparation assignment', () => {
  it('escapes control characters in assignment and full candidate lists', async () => {
    const path = 'generated\n\t\u001b\u007f\u0085.txt';
    const assignment = setup(['a']);

    expect(
      await confirmPreparationAssignment(assignment.context, view.subject, ['requested'], [path]),
    ).toBe('assign');
    expect(assignment.render.mock.lastCall?.[0]).toContain(
      '"generated\\n\\t\\u001b\\u007f\\u0085.txt"',
    );

    const approval = setup(['f'], 30, [['\u001b'], ['a']]);
    await confirmCommitOverlay(approval.context, {
      ...view,
      files: [{ path, added: '1', removed: '0' }],
      preparationAddedFiles: [path],
      repositoryRelative: true,
      allowApproveAll: false,
    });

    expect(
      approval.render.mock.calls.some(([output]) =>
        output.includes('[preparation-added] "generated\\n\\t\\u001b\\u007f\\u0085.txt"'),
      ),
    ).toBe(true);
  });

  it.each([
    ['a', 'assign'],
    ['d', 'decline'],
    ['\u001b', 'abort'],
    ['\u0003', 'abort'],
  ])('handles assignment key %j as %s', async (key, choice) => {
    const { context, render } = setup([key]);

    expect(
      await confirmPreparationAssignment(
        context,
        view.subject,
        ['requested'],
        ['generated'],
        '1/2',
      ),
    ).toBe(choice);
    expect(render.mock.lastCall?.[0]).toContain('Assignment is not commit approval');
    expect(render.mock.lastCall?.[0]).toContain('Preparation assignment 1/2');
  });

  it('scrolls every generated path and does not accept ordinary approval shortcuts', async () => {
    const added = Array.from({ length: 60 }, (_, index) => `generated ${index + 1}`);
    const { context, done, render } = setup(['A', 'w', '\r', 'G'], 20);

    await confirmPreparationAssignment(context, view.subject, ['requested'], added);

    expect(done).not.toHaveBeenCalled();
    expect(render.mock.lastCall?.[0]).toContain('"generated 60"');
  });

  it('hides and ignores approve all for prepared candidates', async () => {
    const { context, done, render } = setup(['A', 'a']);

    expect(await confirmCommitOverlay(context, { ...view, allowApproveAll: false })).toBe(
      'approve',
    );
    expect(done).toHaveBeenCalledExactlyOnceWith('approve');
    expect(render.mock.lastCall?.[0]).not.toContain('Approve all remaining');
  });
});

describe('confirmCommitOverlay', () => {
  it('aborts the commit when Ctrl+C is pressed in the review viewer', async () => {
    const { context, custom } = setup(['r'], 30, [['\u0003'], ['a']]);

    expect(await confirmCommitOverlay(context, { ...view, review: 'Review findings' })).toBe(
      'abort',
    );
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it('opens a scrollable read-only review and returns to commit approval', async () => {
    const { context, render } = setup(['r'], 30, [['\u001b[F', '\u001b'], ['a']]);
    const review = Array.from({ length: 60 }, (_, index) => `Finding ${index + 1}`).join('\n');

    expect(await confirmCommitOverlay(context, { ...view, review })).toBe('approve');
    expect(render.mock.calls.some(([output]) => output.includes('Finding 60'))).toBe(true);
  });

  it('requires an explicit waiver instead of ordinary approval for a blocked review', async () => {
    const { context, done, render } = setup(['a', 'w']);
    const choice = await confirmCommitOverlay(context, {
      ...view,
      review: 'retry.ts:1 [blocking] The comment is stale.',
      reviewBlocked: true,
    });

    expect(choice).toBe('waive');
    expect(done).toHaveBeenCalledExactlyOnceWith('waive');
    expect(render.mock.lastCall?.[0]).toContain('Waive comment review and commit');
    expect(render.mock.lastCall?.[0]).not.toContain('Approve and commit');
  });

  it('hides approve all for a blocked review', async () => {
    const { context, done, render } = setup(['A', 'w']);
    const choice = await confirmCommitOverlay(context, {
      ...view,
      review: 'retry.ts:1 [blocking] The comment is stale.',
      reviewBlocked: true,
    });

    expect(choice).toBe('waive');
    expect(done).toHaveBeenCalledExactlyOnceWith('waive');
    expect(render.mock.lastCall?.[0]).not.toContain('Approve all remaining');
  });

  it.each([
    ['a', 'approve'],
    ['A', 'approveAll'],
    ['s', 'subject'],
    ['b', 'body'],
    ['x', 'skip'],
    ['\u001b', 'abort'],
    ['\u0003', 'abort'],
  ])('handles %j as %s before list navigation', async (key, choice) => {
    const { context, done } = setup([key]);

    expect(await confirmCommitOverlay(context, view)).toBe(choice);
    expect(done).toHaveBeenCalledExactlyOnceWith(choice);
  });

  it('moves the choice list down with j', async () => {
    const { context } = setup(['j', '\r']);

    expect(await confirmCommitOverlay(context, view)).toBe('approveAll');
  });

  it.for([
    ['G', 'abort'],
    ['g', 'approve'],
  ])('jumps the choice list to an end with %j', async ([key, choice]) => {
    const { context } = setup([key as string, '\r']);

    expect(await confirmCommitOverlay(context, view)).toBe(choice);
  });

  it.each(['approve', 'approveAll', 'subject', 'body', 'skip', 'abort'])(
    'selects %s with arrows and enter',
    async (choice) => {
      const index = ['approve', 'approveAll', 'subject', 'body', 'skip', 'abort'].indexOf(choice);
      const { context, done } = setup([...Array.from({ length: index }, () => '\u001b[B'), '\r']);

      expect(await confirmCommitOverlay(context, view)).toBe(choice);
      expect(done).toHaveBeenCalledExactlyOnceWith(choice);
    },
  );

  it('renders the commit, file counts, totals and actions in a centered overlay', async () => {
    const { context, custom, render } = setup(['a']);

    await confirmCommitOverlay(context, view);

    const output = render.mock.lastCall?.[0];

    for (const text of [
      'commit 1/2',
      view.subject,
      '(no body)',
      'Files',
      'src/foo.ts',
      '+12 -3',
      'image.png binary',
      'Total: +12 -3',
      'a    Approve and commit',
      'A    Approve all remaining',
      's    Edit subject',
      'b    Edit body',
      'x    Skip this group',
      'esc  Abort',
    ]) {
      expect(output).toContain(text);
    }
    expect(output).toMatch(/\(no body\) *\n *\n *Files/);
    expect(output).toMatch(/Total: \+12 -3 *\n *\n.*Approve and commit/);
    expect(custom.mock.lastCall?.[1]).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: 'center',
        width: '80%',
        maxWidth: 100,
        minWidth: 40,
        maxHeight: '90%',
      },
    });
  });

  it('renders a body and validation notice', async () => {
    const { context, render } = setup(['a']);

    await confirmCommitOverlay(context, {
      ...view,
      body: 'Why\nMore context',
      notice: 'Invalid subject: nope',
    });

    expect(render.mock.lastCall?.[0]).toContain('Why');
    expect(render.mock.lastCall?.[0]).toContain('More context');
    expect(render.mock.lastCall?.[0]).toContain('Invalid subject: nope');
  });

  it('caps a long body at ten lines with a remainder note', async () => {
    const { context, render } = setup(['a']);
    const body = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n');

    await confirmCommitOverlay(context, { ...view, body });

    const output = render.mock.lastCall?.[0] ?? '';

    expect(output).toContain('line 10');
    expect(output).not.toContain('line 11');
    expect(output).toContain('… 4 more lines');
  });

  it('caps the file list at fifteen rows and still totals every file', async () => {
    const { context, render } = setup(['a']);
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `src/file${index + 1}.ts`,
      added: '1',
      removed: '1',
    }));

    await confirmCommitOverlay(context, { ...view, files });

    const output = render.mock.lastCall?.[0] ?? '';

    expect(output).toContain('src/file15.ts');
    expect(output).not.toContain('src/file16.ts');
    expect(output).toContain('… 5 more files');
    expect(output).toContain('Total: +20 -20');
  });

  it('shrinks both caps on a short terminal', async () => {
    const { context, render } = setup(['a'], 30);
    const body = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
    const files = Array.from({ length: 10 }, (_, index) => ({
      path: `src/file${index + 1}.ts`,
      added: '1',
      removed: '1',
    }));

    await confirmCommitOverlay(context, { ...view, body, files });

    const output = render.mock.lastCall?.[0] ?? '';

    expect(output).toContain('… 4 more lines');
    expect(output).toContain('… 4 more files');
  });

  it('truncates long rows to the width instead of wrapping', async () => {
    const { context, render } = setup(['a']);
    const body = 'x'.repeat(300);
    const files = [{ path: `src/${'y'.repeat(300)}.ts`, added: '1', removed: '1' }];

    await confirmCommitOverlay(context, { ...view, body, files });

    const lines = (render.mock.lastCall?.[0] ?? '').split('\n');

    expect(lines.filter((line) => line.includes('xxxxxxxx'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('yyyyyyyy'))).toHaveLength(1);
  });

  it('does not resolve inherited object keys as shortcuts', async () => {
    const { context, done } = setup(['constructor']);

    await confirmCommitOverlay(context, view);

    expect(done).not.toHaveBeenCalled();
  });

  it('treats dismissal as abort', async () => {
    const { context } = setup([]);

    expect(await confirmCommitOverlay(context, view)).toBe('abort');
  });

  it('resolves abort when the signal aborts while the overlay is open', async () => {
    const controller = new AbortController();
    const done = vi.fn<(result: unknown) => void>();
    const custom = vi.fn<
      (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => Promise<unknown>
    >(async (factory) => {
      const component = await factory(
        { requestRender: vi.fn<() => void>(), terminal: { rows: 60 } } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        {} as never,
        done,
      );

      controller.abort();
      component.dispose?.();
      controller.abort();

      return done.mock.lastCall?.[0];
    });
    const context = { ui: { custom } } as unknown as ExtensionContext;

    expect(await confirmCommitOverlay(context, view, controller.signal)).toBe('abort');
    expect(done).toHaveBeenCalledExactlyOnceWith('abort');
  });

  it('returns abort without opening the overlay when the signal is already aborted', async () => {
    const { context, custom } = setup(['a']);

    expect(await confirmCommitOverlay(context, view, AbortSignal.abort())).toBe('abort');
    expect(custom).not.toHaveBeenCalled();
  });
});
