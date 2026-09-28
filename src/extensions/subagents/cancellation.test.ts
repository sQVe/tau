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

it('matches a Pi worker by start time when herdr omits its argv', () => {
  expect(matchesWorker(information, { ...worker, startedAt: 'Mon Sep 21 10:43:04 2026' })).toBe(
    true,
  );

  expect(matchesWorker(information, { ...worker, startedAt: '' })).toBe(false);
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
