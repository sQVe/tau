import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { processState } from '../src/process/process.js';
import { startHcSession } from './hcSessionHarness.js';
import { launchWorkerSession } from './subagentSessionHarness.js';

// A worker that keeps creating files in its agent directory, as a live worker does.
const writingWorker = `
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const agentDirectory = process.argv[2];
const pidPath = join(agentDirectory, 'worker.pid');

writeFileSync(pidPath + '.tmp', String(process.pid));
renameSync(pidPath + '.tmp', pidPath);

let tick = 0;

setInterval(() => {
  try {
    writeFileSync(join(agentDirectory, 'tick-' + tick), 'tick');
    tick += 1;
  } catch {
    // The directory may be gone. A real worker keeps running anyway.
  }
}, 5);
`;

vi.setConfig({ testTimeout: 120_000 });

const pollMilliseconds = 20;
const pidDeadlineMilliseconds = 30_000;
const stopDeadlineMilliseconds = 5000;

const readWorkerProcessId = async (path: string): Promise<number> => {
  let processId = 0;

  await vi.waitFor(
    () => {
      processId = Number(readFileSync(path, 'utf8'));

      expect(Number.isInteger(processId) && processId > 1).toBe(true);
    },
    { timeout: pidDeadlineMilliseconds, interval: pollMilliseconds },
  );

  return processId;
};

it('stops the worker before it removes the worker directories', async ({ onTestFinished }) => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const directories: string[] = [];
  const existingWhenStopped: string[][] = [];
  const cleaned: { processId: number }[] = [];

  const stop = hc.stop;

  vi.spyOn(hc, 'stop').mockImplementation(async () => {
    await stop();

    existingWhenStopped.push(directories.filter((directory) => existsSync(directory)));
  });

  // Registered before the launch, so this runs after the worker's own cleanup and before the
  // session stop that startHcSession registered first.
  onTestFinished(async () => {
    const entry = cleaned.at(0);

    if (entry === undefined) {
      return;
    }

    await vi.waitFor(
      () => {
        expect(processState(entry.processId)).toBe('gone');
      },
      { timeout: stopDeadlineMilliseconds, interval: pollMilliseconds },
    );

    expect(existingWhenStopped.at(0)).toEqual(directories);
    expect(directories.filter((directory) => existsSync(directory))).toEqual([]);
  });

  const worker = await launchWorkerSession({
    hc,
    model: { provider: 'fixture', id: 'fixture' },
    task: 'Write files until the worker is stopped.',
    acceptance: ['The worker is stopped.'],
    command: { source: writingWorker },
  });

  const processId = await readWorkerProcessId(join(worker.agentDirectory, 'worker.pid'));

  expect(processState(processId)).toBe('running');

  directories.push(worker.agentDirectory, worker.workerDirectory);
  cleaned.push({ processId });
});
