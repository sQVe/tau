import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { parseEvent } from '../../improvement/event.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import improvementExtension from './improvement.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

const sessionStartContext = (cwd: string) => ({ cwd }) as unknown as ExtensionContext;

afterEach(() => {
  vi.unstubAllEnvs();
});

const sessionContext = (cwd: string) =>
  ({
    cwd,
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/sessions/one.jsonl',
    },
  }) as unknown as ExtensionToolContext;

const runManagerTool = async (cwd: string, input: Record<string, unknown>) => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi();

  improvementExtension(fake.pi);
  const tool = fake.tools.get('improvement');

  if (tool === undefined) {
    throw new Error('The manager has no improvement tool.');
  }

  const result = await tool.execute('call-1', input, undefined, undefined, sessionContext(cwd));

  return result.details as { path: string };
};

it('registers no improvement tool in a worker', () => {
  vi.stubEnv('TAU_ROLE', 'worker');
  const fake = fakeExtensionApi();

  improvementExtension(fake.pi);

  expect(fake.tools.has('improvement')).toBe(false);
});

it('starts no sweep in a worker session', () => {
  vi.stubEnv('TAU_ROLE', 'worker');
  const fake = fakeExtensionApi();
  const runSweep = vi.fn<SweepRunner>();

  improvementExtension(fake.pi, { runSweep });

  expect({
    handlers: fake.handlers.get('session_start') ?? [],
    calls: runSweep.mock.calls,
  }).toEqual({
    handlers: [],
    calls: [],
  });
});

it('records a correction from the session the manager runs', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const { path } = await runManagerTool(root, {
    action: 'record',
    summary: 'Use run_tests for tests.',
  });

  const event = parseEvent(path, await readFile(path, 'utf8'));

  expect(event).toMatchObject({
    kind: 'correction',
    summary: 'Use run_tests for tests.',
    cwd: root,
    evidence: [{ kind: 'transcript', path: '/sessions/one.jsonl', toolCallId: 'call-1' }],
  });
});

it('starts a sweep at manager session start', () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi();
  const runSweep = vi.fn<SweepRunner>(async () => ({ outcome: 'caughtUp' }));

  improvementExtension(fake.pi, { runSweep });
  fake.handler('session_start')({}, sessionStartContext('/work/me-1'));

  expect(runSweep).toHaveBeenCalledTimes(1);
  expect(runSweep).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work/me-1' }));
});

it('returns from session start before the sweep finishes', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi();
  const { promise, resolve } = Promise.withResolvers<SweepOutcome>();
  const runSweep = vi.fn<SweepRunner>(() => promise);

  improvementExtension(fake.pi, { runSweep });
  const returned = fake.handler('session_start')({}, sessionStartContext('/work/me-1'));

  expect({ returned, calls: runSweep.mock.calls.length }).toEqual({
    returned: undefined,
    calls: 1,
  });

  resolve({ outcome: 'caughtUp' });
  await promise;
});

it('refuses a record call without a summary', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const failure = await runManagerTool(root, { action: 'record' }).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect({ failure, saved: existsSync(join(root, '.tau', 'improvement')) }).toEqual({
    failure: 'record needs summary.',
    saved: false,
  });
});
