import { getEventListeners } from 'node:events';

import { afterEach, expect, it, vi } from 'vitest';

import { matchesWorker, processAbsent, runClient } from './cancellation.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const information = {
  pane_id: 'pane',
  shell_pid: 101,
  foreground_process_group_id: 101,
  foreground_processes: [{ name: 'pi', pid: 101 }],
};

const worker = {
  kind: 'pi' as const,
  paneId: 'pane',
  terminalId: 'terminal',
  shellPid: 101,
  processId: 101,
  token: '/tmp/session',
};

it('matches a Pi worker by process ID when herdr omits its argv', () => {
  expect(matchesWorker(information, { ...worker, startedAt: 'Mon Sep 21 10:43:04 2026' })).toBe(
    true,
  );
});

it.each([
  { name: 'pane', change: { pane_id: 'other' } },
  { name: 'shell', change: { shell_pid: 202 } },
  { name: 'foreground process group', change: { foreground_process_group_id: 202 } },
  { name: 'foreground process', change: { foreground_processes: [{ name: 'pi', pid: 202 }] } },
])('refuses a pane whose $name belongs to another process', ({ change }) => {
  expect(matchesWorker({ ...information, ...change }, { ...worker, startedAt: 'start' })).toBe(
    false,
  );
});

it('matches a Pi worker among other foreground processes', () => {
  const processes = [{ name: 'tail', pid: 303 }, ...information.foreground_processes];
  const pane = { ...information, foreground_processes: processes };

  expect(matchesWorker(pane, { ...worker, startedAt: 'start' })).toBe(true);
});

it('counts a process as absent only when the kernel reports no such process', () => {
  const signals: unknown[] = [];

  vi.spyOn(process, 'kill').mockImplementation((processId, signal) => {
    signals.push([processId, signal]);

    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });

  expect(processAbsent(101)).toBe(true);
  expect(signals).toEqual([[101, 0]]);
});

it('never counts EPERM as an absent process', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  });

  expect(processAbsent(101)).toBe(false);
});

it('bounds a real stalled client and reports failure instead of success', async () => {
  const started = performance.now();

  await expect(
    runClient(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 150),
  ).rejects.toThrow('budget');

  expect(performance.now() - started).toBeLessThan(1500);
});

it('reports failed client calls', async () => {
  await expect(runClient(process.execPath, ['-e', 'process.exit(2)'], 1000)).rejects.toThrow(
    'Command failed',
  );
});

it.each([0, -1, Number.NaN, 2_147_483_648])('refuses an invalid client budget %s', (budget) => {
  expect(() => runClient(process.execPath, ['-e', ''], budget)).toThrow('integer');
});

it('keeps the herdr error output of a failed client call', async () => {
  await expect(
    runClient(
      process.execPath,
      ['-e', 'process.stderr.write("pane missing"); process.exit(2)'],
      1000,
    ),
  ).rejects.toMatchObject({ stderr: 'pane missing' });
});

it('stops a stalled client call when the caller aborts', async () => {
  const controller = new AbortController();

  const call = runClient(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 60_000, {
    signal: controller.signal,
  });

  controller.abort();

  await expect(call).rejects.toThrow('cancelled');
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
});

it.each([
  { name: 'finished', script: '', budget: 1000 },
  { name: 'stalled', script: 'setInterval(() => {}, 1000)', budget: 150 },
])('removes its abort listener after a $name client call', async ({ script, budget }) => {
  const controller = new AbortController();

  await runClient(process.execPath, ['-e', script], budget, { signal: controller.signal }).catch(
    () => undefined,
  );

  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
});
