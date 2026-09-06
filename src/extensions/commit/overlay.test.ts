import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { confirmCommitOverlay } from './overlay.js';

const view = {
  subject: 'feat: add overlay',
  body: null,
  files: [
    { path: 'src/foo.ts', added: '12', removed: '3' },
    { path: 'image.png', added: '-', removed: '-' },
  ],
  group: '1/2',
};

const setup = (keys: string[]) => {
  const done = vi.fn<(result: unknown) => void>();
  const render = vi.fn<(text: string) => void>();
  const custom = vi.fn<
    (
      factory: Parameters<ExtensionContext['ui']['custom']>[0],
      options?: unknown,
    ) => Promise<unknown>
  >(async (factory: Parameters<ExtensionContext['ui']['custom']>[0], _options?: unknown) => {
    const component = await factory(
      { requestRender: vi.fn<() => void>() } as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      {} as never,
      done,
    );
    render(component.render(80).join('\n'));
    component.invalidate();
    for (const key of keys) {
      component.handleInput?.(key);
    }
    return done.mock.lastCall?.[0];
  });
  return { ctx: { ui: { custom } } as unknown as ExtensionContext, custom, done, render };
};

describe('confirmCommitOverlay', () => {
  it.each([
    ['a', 'approve'],
    ['s', 'subject'],
    ['b', 'body'],
    ['k', 'skip'],
    ['\u001b', 'abort'],
    ['\u0003', 'abort'],
  ])('handles %j as %s before list navigation', async (key, choice) => {
    const { ctx, done } = setup([key]);
    expect(await confirmCommitOverlay(ctx, view)).toBe(choice);
    expect(done).toHaveBeenCalledExactlyOnceWith(choice);
  });

  it.each(['approve', 'subject', 'body', 'skip', 'abort'])(
    'selects %s with arrows and enter',
    async (choice) => {
      const index = ['approve', 'subject', 'body', 'skip', 'abort'].indexOf(choice);
      const { ctx, done } = setup([...Array.from({ length: index }, () => '\u001b[B'), '\r']);
      expect(await confirmCommitOverlay(ctx, view)).toBe(choice);
      expect(done).toHaveBeenCalledExactlyOnceWith(choice);
    },
  );

  it('renders the commit, file counts, totals and actions in a centered overlay', async () => {
    const { ctx, custom, render } = setup(['a']);
    await confirmCommitOverlay(ctx, view);
    const output = render.mock.lastCall?.[0];
    for (const text of [
      'commit 1/2',
      view.subject,
      '(no body)',
      'Files',
      'src/foo.ts',
      '+12 -3',
      'image.png',
      '+- --',
      'Total: +12 -3',
      'Approve and commit',
      'Edit subject',
      'Edit body',
      'Skip this group',
      'Abort',
      'a approve • s subject • b body • k skip • esc abort',
    ]) {
      expect(output).toContain(text);
    }
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
    const { ctx, render } = setup(['a']);
    await confirmCommitOverlay(ctx, {
      ...view,
      body: 'Why\nMore context',
      notice: 'Invalid subject: nope',
    });
    expect(render.mock.lastCall?.[0]).toContain('Why');
    expect(render.mock.lastCall?.[0]).toContain('More context');
    expect(render.mock.lastCall?.[0]).toContain('Invalid subject: nope');
  });

  it('does not resolve inherited object keys as shortcuts', async () => {
    const { ctx, done } = setup(['constructor']);
    await confirmCommitOverlay(ctx, view);
    expect(done).not.toHaveBeenCalled();
  });

  it('treats dismissal as abort', async () => {
    const { ctx } = setup([]);
    expect(await confirmCommitOverlay(ctx, view)).toBe('abort');
  });

  it('resolves abort when the signal aborts while the overlay is open', async () => {
    const controller = new AbortController();
    const done = vi.fn<(result: unknown) => void>();
    const custom = vi.fn<
      (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => Promise<unknown>
    >(async (factory) => {
      const component = await factory(
        { requestRender: vi.fn<() => void>() } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        {} as never,
        done,
      );
      controller.abort();
      component.dispose?.();
      controller.abort();
      return done.mock.lastCall?.[0];
    });
    const ctx = { ui: { custom } } as unknown as ExtensionContext;

    expect(await confirmCommitOverlay(ctx, view, controller.signal)).toBe('abort');
    expect(done).toHaveBeenCalledExactlyOnceWith('abort');
  });

  it('returns abort without opening the overlay when the signal is already aborted', async () => {
    const { ctx, custom } = setup(['a']);

    expect(await confirmCommitOverlay(ctx, view, AbortSignal.abort())).toBe('abort');
    expect(custom).not.toHaveBeenCalled();
  });
});
