import { readdirSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createSweepFixture } from '../../../tests/sweepHarness.js';
import type { SweepFixture } from '../../../tests/sweepHarness.js';
import { sessionHeader } from '../../../tests/transcriptHarness.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import { writeSweepIndex } from '../../improvement/sweepIndex.js';
import improvementExtension from './improvement.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

type SetStatus = (key: string, text: string | undefined) => void;

const sessionContext = (cwd: string, setStatus: SetStatus = () => undefined) =>
  ({ cwd, hasUI: true, ui: { setStatus } }) as unknown as ExtensionContext;

const writeManagerSession = (fixture: SweepFixture): void => {
  fixture.writeSession('manager.jsonl', `${sessionHeader(fixture.repository)}\n`);
};

const holdSweepCompletion = (fixture: SweepFixture) => {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();

  const run: SweepRunner = async (options) => {
    const outcome = await fixture.run({ ...options, exec: fixture.fake.exec });

    reached.resolve(undefined);
    await released.promise;

    return outcome;
  };

  return {
    run,
    reached: reached.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
};

const directoryContents = (directory: string): { path: string; content: string }[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);

      return { path: relative(directory, path), content: readFileSync(path, 'utf8') };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));

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
  const gate = fixture.gateMergedList();
  const held = holdSweepCompletion(fixture);

  writeManagerSession(fixture);
  vi.stubEnv('PI_CODING_AGENT_DIR', fixture.agentDirectory);

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep: held.run });

  fake.handler('session_start')({}, sessionContext(fixture.repository));
  await gate.reached;

  let resolved = false;
  const shutdownHandler = fake.handler('session_shutdown');
  const shutdownResult = shutdownHandler({}, sessionContext(fixture.repository));

  const shutdown = Promise.resolve(shutdownResult).then(() => {
    resolved = true;

    return undefined;
  });

  await held.reached;

  expect(resolved).toBe(false);

  held.release();
  await shutdown;

  const contents = directoryContents(fixture.agentDirectory);

  await flushImmediate();

  expect({
    lastSweep: (await fixture.readIndex()).lastSweep,
    contents: directoryContents(fixture.agentDirectory),
  }).toEqual({
    lastSweep: expect.objectContaining({ outcome: 'budget' }) as unknown,
    contents,
  });
});

it('makes two overlapping shutdowns await the same drain', async () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fixture = await createSweepFixture(onTestFinished);
  const gate = fixture.gateMergedList();
  const held = holdSweepCompletion(fixture);
  const settled: string[] = [];

  writeManagerSession(fixture);
  vi.stubEnv('PI_CODING_AGENT_DIR', fixture.agentDirectory);

  const fake = fakeExtensionApi();
  improvementExtension(fake.pi, { runSweep: held.run });

  const shutdown = (name: string) => {
    const handler = fake.handler('session_shutdown');
    const result = handler({}, sessionContext(fixture.repository));

    return Promise.resolve(result).then(() => {
      settled.push(name);

      return undefined;
    });
  };

  fake.handler('session_start')({}, sessionContext(fixture.repository));
  await gate.reached;

  const first = shutdown('first');
  const second = shutdown('second');

  await held.reached;
  await flushImmediate();

  expect(settled).toEqual([]);

  held.release();
  await Promise.all([first, second]);

  expect(settled.toSorted()).toEqual(['first', 'second']);
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
