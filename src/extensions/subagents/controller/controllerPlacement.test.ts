import { readdirSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

import { readTask } from '../records.js';
import { setup } from './fixtures/controllerFixture.js';
import { workerArguments } from './inspect.js';

vi.mock(import('node:fs'), { spy: true });

const dispatchRecordedForWorker = (calls: string[][]): boolean => {
  const launch = calls.find((call) => call[0] === 'layout')?.[2];

  const recordDirectory =
    launch === undefined
      ? undefined
      : (JSON.parse(launch) as { root: { env: Record<string, string> } }).root.env
          .TAU_WORKER_RECORD;

  return recordDirectory !== undefined && readdirSync(recordDirectory).includes('dispatch.json');
};

it('dispatches the task before a stalled cosmetic pane rename can hold the launch', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const renameStarted = Promise.withResolvers<undefined>();
  let dispatchedWhenRenameStarted: boolean | undefined;

  const { controller, input, calls } = setup(
    onTestFinished,
    0,
    async (argumentsList, _budget, signal) => {
      if (argumentsList[1] === 'rename') {
        dispatchedWhenRenameStarted = dispatchRecordedForWorker(calls);
        renameStarted.resolve(undefined);

        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('rename aborted'));
            },
            { once: true },
          );
        });
      }

      return '';
    },
  );

  const launching = controller.launch(input);

  await renameStarted.promise;
  expect(dispatchedWhenRenameStarted).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  const launched = await launching;

  expect(launched.failure).toBeUndefined();
  expect(readdirSync(launched.directory)).toContain('dispatch.json');
  expect(calls.some((call) => call[1] === 'rename')).toBe(true);
  expect(calls.filter((call) => call[1] === 'rename')).toHaveLength(1);
});

it('bounds a stalled cosmetic terminal resolution by the same short deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const resolutionStalled = Promise.withResolvers<undefined>();
  let started = false;
  let dispatchedWhenResolutionStalled: boolean | undefined;

  const { controller, input, calls } = setup(
    onTestFinished,
    0,
    async (argumentsList, _budget, signal) => {
      if (argumentsList[0] === 'layout') {
        started = true;
      }

      const cosmeticResolution =
        started && argumentsList[0] === 'pane' && argumentsList[1] === 'list';

      if (cosmeticResolution && dispatchRecordedForWorker(calls)) {
        dispatchedWhenResolutionStalled = dispatchRecordedForWorker(calls);
        resolutionStalled.resolve(undefined);

        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('terminal resolution aborted'));
            },
            { once: true },
          );
        });
      }

      return '';
    },
  );

  const launching = controller.launch(input);

  await resolutionStalled.promise;
  expect(dispatchedWhenResolutionStalled).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  const launched = await launching;

  expect(launched.failure).toBeUndefined();
  expect(readdirSync(launched.directory)).toContain('dispatch.json');
  expect(calls.some((call) => call[1] === 'rename')).toBe(false);
});

it('chooses a down split for a narrow tall parent without changing focus', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'current') {
      return JSON.stringify({
        result: {
          pane: {
            pane_id: 'parent',
            terminal_id: 'parent-terminal',
            workspace_id: 'workspace',
            tab_id: 'tab',
          },
        },
      });
    }

    if (argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: 'parent',
              terminal_id: 'parent-terminal',
              workspace_id: 'workspace',
              tab_id: 'tab',
            },
            {
              pane_id: 'worker-1',
              terminal_id: 'terminal-1',
              workspace_id: 'workspace',
              tab_id: 'tab',
            },
          ],
        },
      });
    }

    if (argumentsList[1] === 'layout') {
      return JSON.stringify({
        result: {
          layout: {
            workspace_id: 'workspace',
            tab_id: 'tab',
            zoomed: false,
            area: { width: 100, height: 90 },
            panes: [{ pane_id: 'parent', rect: { width: 100, height: 90 } }],
          },
        },
      });
    }

    return '';
  });

  const launched = await controller.launch(input);

  expect(launched.failure).toBeUndefined();

  expect(calls.find((call) => call[1] === 'move')).toEqual(
    expect.arrayContaining(['--split', 'down', '--no-focus']),
  );

  expect(calls.some((call) => call[1] === 'resize' || call[1] === 'focus')).toBe(false);
});

it('renames the owned worker pane with its name and model', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'rename') {
      return JSON.stringify({ result: { pane: {} } });
    }

    return '';
  });

  await controller.launch(input);

  const rename = calls.find((call) => call[1] === 'rename');

  expect(rename?.slice(0, 3)).toEqual(['pane', 'rename', 'worker-1']);
  expect(rename?.[3]).toMatch(/^worker-[a-z0-9]{2} \(test\)$/);
});

it('titles the worker pane with the model ID after the provider', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'rename') {
      return JSON.stringify({ result: { pane: {} } });
    }

    return '';
  });

  const loadout = { ...input.loadout, model: 'openrouter/meta/llama' };
  const launched = await controller.launch({ ...input, loadout });
  const rename = calls.find((call) => call[1] === 'rename');

  expect(rename?.[3]).toMatch(/^worker-[a-z0-9]{2} \(meta-llama\)$/);

  expect(workerArguments(readTask(launched.directory), []).slice(3, 7)).toEqual([
    '--provider',
    'openrouter',
    '--model',
    'meta/llama',
  ]);
});

it('keeps a worker running when the pane display title write is rejected', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[1] === 'rename') {
      throw new Error('rename unsupported');
    }

    return '';
  });

  const launched = await controller.launch(input);

  expect(calls.some((call) => call[1] === 'rename')).toBe(true);
  expect(launched.state).not.toBe('cleanupUnconfirmed');
  expect(launched.state).not.toBe('notOwned');
});
