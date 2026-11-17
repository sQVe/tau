import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import type { ImprovementStatus } from '../../improvement/statusDecision.js';
import { createStatusRefresh } from './statusAction.js';

type SetStatus = (key: string, text: string | undefined) => void;

const statusWithTasks = (count: number): ImprovementStatus => ({
  projectRoot: '/work/project',
  tasks: Array.from({ length: count }, (_, index) => ({
    pullRequest: `https://github.com/sQVe/tau/pull/${index + 1}`,
    mergedAt: '2026-11-15T12:00:00.000Z',
    signals: ['reviewRounds'],
  })),
  correctDue: false,
  coverage: { complete: count, managerOnly: 0, missing: 0 },
  sweep: 'complete',
  skipped: [],
});

const contextWithUI = (setStatus: SetStatus): ExtensionContext =>
  ({ hasUI: true, cwd: '/work/project', ui: { setStatus } }) as unknown as ExtensionContext;

it('sets the unreadable text and resolves when the read throws', async () => {
  const setStatus = vi.fn<SetStatus>();

  const refresh = createStatusRefresh(async () => {
    throw new Error('read failed');
  });

  await expect(refresh(contextWithUI(setStatus))).resolves.toBeUndefined();

  expect(setStatus).toHaveBeenCalledWith('improvement', 'improve: status unreadable');
});

it('does nothing without UI', async () => {
  const setStatus = vi.fn<SetStatus>();

  const read = vi.fn<(cwd: string) => Promise<ImprovementStatus>>(async () => statusWithTasks(0));
  const refresh = createStatusRefresh(read);

  const context = {
    hasUI: false,
    cwd: '/work/project',
    ui: { setStatus },
  } as unknown as ExtensionContext;

  await refresh(context);

  expect({ setStatus: setStatus.mock.calls, reads: read.mock.calls }).toEqual({
    setStatus: [],
    reads: [],
  });
});

it('resolves when setStatus throws', async () => {
  const refresh = createStatusRefresh(async () => statusWithTasks(1));

  const context = contextWithUI(() => {
    throw new Error('stale session');
  });

  await expect(refresh(context)).resolves.toBeUndefined();
});

it('keeps the newer text when an older read finishes later', async () => {
  const older = Promise.withResolvers<ImprovementStatus>();
  const newer = Promise.withResolvers<ImprovementStatus>();
  const reads = [older.promise, newer.promise];

  const setStatus = vi.fn<SetStatus>();

  const refresh = createStatusRefresh(() => {
    const next = reads.shift();

    if (next === undefined) {
      throw new Error('No read left.');
    }

    return next;
  });

  const context = contextWithUI(setStatus);

  const olderCall = refresh(context);
  const newerCall = refresh(context);

  newer.resolve(statusWithTasks(2));
  await newerCall;

  older.resolve(statusWithTasks(1));
  await olderCall;

  expect(setStatus.mock.calls).toEqual([['improvement', 'improve: 2 tasks to review']]);
});
