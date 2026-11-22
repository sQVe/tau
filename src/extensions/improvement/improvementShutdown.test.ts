import { readdirSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createSweepFixture } from '../../../tests/sweepHarness.js';
import type { SweepFixture } from '../../../tests/sweepHarness.js';
import type { Exec } from '../../command.js';
import { runSweep } from '../../improvement/sweep.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import { writeSweepIndex } from '../../improvement/sweepIndex.js';
import improvementExtension from './improvement.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

type SetStatus = (key: string, text: string | undefined) => void;

const sessionContext = (cwd: string, setStatus: SetStatus = () => undefined) =>
  ({ cwd, hasUI: true, ui: { setStatus } }) as unknown as ExtensionContext;

const writeManagerSession = (fixture: SweepFixture): void => {
  fixture.writeSession(
    'manager.jsonl',
    `${JSON.stringify({
      type: 'session',
      id: 'manager',
      timestamp: '2026-11-01T00:00:00.000Z',
      cwd: fixture.repository,
    })}\n`,
  );
};

const gateMergedList = (fixture: SweepFixture) => {
  const reached = Promise.withResolvers<undefined>();

  const exec: Exec = (command, commandArguments, options) => {
    const isMergedList =
      command === 'gh' && commandArguments[0] === 'pr' && commandArguments[1] === 'list';

    if (!isMergedList) {
      return fixture.fake.exec(command, commandArguments, options);
    }

    reached.resolve(undefined);

    const signal = options?.signal;

    if (signal === undefined) {
      throw new Error('The sweep passed no signal to the merged list.');
    }

    const aborted = Promise.withResolvers<never>();

    signal.addEventListener(
      'abort',
      () => {
        aborted.reject(signal.reason);
      },
      { once: true },
    );

    return aborted.promise;
  };

  return { exec, reached: reached.promise };
};

const directoryListing = (directory: string): { path: string; size: number }[] => {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);

      return { path: relative(directory, path), size: statSync(path).size };
    });

  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
};

const flushImmediate = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const runUntilAborted: SweepRunner = (options) =>
  new Promise((resolve) => {
    options.signal.addEventListener(
      'abort',
      () => {
        resolve({ outcome: 'caughtUp' });
      },
      {
        once: true,
      },
    );
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

it('stops a running sweep at session shutdown and writes nothing afterwards', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fixture = await createSweepFixture(onTestFinished);
  const { exec, reached } = gateMergedList(fixture);
  const shutdown = Promise.withResolvers<undefined>();

  writeManagerSession(fixture);
  vi.stubEnv('PI_CODING_AGENT_DIR', fixture.agentDirectory);

  let settled = false;

  const run: SweepRunner = async (options) => {
    try {
      return await runSweep({ ...options, exec });
    } finally {
      settled = true;
      shutdown.resolve(undefined);
    }
  };

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep: run });

  fake.handler('session_start')({}, sessionContext(fixture.repository));
  await reached;
  await fake.handler('session_shutdown')({}, sessionContext(fixture.repository));

  const before = directoryListing(fixture.agentDirectory);

  await flushImmediate();

  expect({
    settled,
    lastSweep: (await fixture.readIndex()).lastSweep,
    listing: directoryListing(fixture.agentDirectory),
  }).toEqual({
    settled: true,
    lastSweep: expect.objectContaining({ outcome: 'budget' }) as unknown,
    listing: before,
  });
});

it('does not refresh the status after a stopped sweep', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fixture = await createSweepFixture(onTestFinished);
  const projectRoot = await realpath(fixture.repository);
  const setStatus = vi.fn<SetStatus>();

  writeManagerSession(fixture);

  await writeSweepIndex(fixture.agentDirectory, {
    version: 1,
    transcripts: {},
    projects: {
      [projectRoot]: {
        repository: 'sqve/tau',
        merged: { status: 'read', at: '2026-11-15T12:00:00.000Z', count: 0 },
      },
    },
    lastSweep: { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'caughtUp' },
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', fixture.agentDirectory);

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep: runUntilAborted });

  fake.handler('session_start')({}, sessionContext(fixture.repository, setStatus));

  await vi.waitFor(() => {
    expect(setStatus).toHaveBeenCalledWith('improvement', undefined);
  });

  const callsBeforeShutdown = setStatus.mock.calls.length;

  await fake.handler('session_shutdown')({}, sessionContext(fixture.repository, setStatus));
  await flushImmediate();

  expect(setStatus.mock.calls.length).toBe(callsBeforeShutdown);
});
