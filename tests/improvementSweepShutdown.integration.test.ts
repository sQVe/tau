import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';

import improvementExtension from '../src/extensions/improvement/improvement.js';
import type { SweepOptions, SweepOutcome } from '../src/improvement/sweep.js';
import { readSweepIndex } from '../src/improvement/sweepIndex.js';
import { createPiSession, shutdownSession } from './piSession.js';
import { createSweepFixture } from './sweepHarness.js';
import { sessionHeader } from './transcriptHarness.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

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

it('writes nothing after a real session shutdown returns', async ({ onTestFinished }) => {
  vi.stubEnv('TAU_ROLE', undefined);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const fixture = await createSweepFixture(onTestFinished);
  const gate = fixture.gateMergedList();

  fixture.writeSession('manager.jsonl', `${sessionHeader(fixture.repository)}\n`);
  vi.stubEnv('PI_CODING_AGENT_DIR', fixture.agentDirectory);

  const runSweep: SweepRunner = (options) => fixture.run({ ...options, exec: fixture.fake.exec });

  const { session } = await createPiSession(onTestFinished, {
    cwd: fixture.repository,
    agentDirectory: fixture.agentDirectory,
    providers: [fauxProvider()],
    extensionFactories: [
      (pi) => {
        improvementExtension(pi, { runSweep });
      },
    ],
  });

  await session.bindExtensions({});
  await gate.reached;

  await shutdownSession(session);

  const contents = directoryContents(fixture.agentDirectory);

  await flushImmediate();

  const read = await readSweepIndex(fixture.agentDirectory);
  const lastSweep = read.status === 'read' ? read.index.lastSweep : null;

  expect({
    lastSweep,
    contents: directoryContents(fixture.agentDirectory),
  }).toEqual({
    lastSweep: expect.objectContaining({ outcome: 'budget' }) as unknown,
    contents,
  });
});
