import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import {
  TuicrExitTimeoutError,
  endReviewTerminal,
  openReviewTerminal,
  reviewWaitTimeoutSeconds,
  waitForReviewExit,
} from '../src/extensions/draftReview/hcReview.js';
import { get, run } from '../src/hc/hc.js';
import { startHcSession } from './hcSessionHarness.js';

// A running terminal that the wait gives up on after one second.
const runningWaitTimeoutSeconds = 1;

// CI does not install tuicr, so the open test puts a stub named tuicr first on PATH. hc starts
// the terminal's argv from the session's PATH, so the stub must be there before the terminal opens.
const stubTuicrOnPath = (): void => {
  const binDirectory = mkdtempSync(join(tmpdir(), 'tau-tuicr-stub-'));
  const stubPath = join(binDirectory, 'tuicr');

  writeFileSync(stubPath, '#!/bin/sh\nexec sleep 60\n');
  chmodSync(stubPath, 0o755);

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(binDirectory, { recursive: true, force: true });
  });

  vi.stubEnv('PATH', `${binDirectory}:${process.env['PATH'] ?? ''}`);
};

it('opens a review terminal with the space label, its tuicr argv, and a draft name', async () => {
  stubTuicrOnPath();

  const hc = await startHcSession(onTestFinished);
  const stagingDirectory = join(hc.root, 'staging');

  mkdirSync(stagingDirectory);

  const address = await openReviewTerminal(hc.runtime, { stagingDirectory, space: 'space-a' });
  const terminal = await get(hc.runtime, address);

  await endReviewTerminal(hc.runtime, address);

  expect(terminal.labels?.['herdr.space']).toBe('space-a');
  expect(terminal.argv).toEqual(['tuicr', '--file', stagingDirectory]);
  expect(terminal.name).toMatch(/^draft-review-[0-9a-f]{8}$/);
});

it('returns from a wait for an exited review terminal', async () => {
  const hc = await startHcSession(onTestFinished);
  const exited = await run(hc.runtime, { argv: ['sh', '-c', 'exit 0'], background: true });

  await expect(
    waitForReviewExit(hc.runtime, {
      address: exited.address,
      recordDirectory: hc.root,
      timeoutSeconds: reviewWaitTimeoutSeconds,
    }),
  ).resolves.toBeUndefined();
});

it('throws from a wait for a running review terminal, which the test then ends', async () => {
  const hc = await startHcSession(onTestFinished);
  const running = await run(hc.runtime, { argv: ['sleep', '60'], background: true });

  const failure = await waitForReviewExit(hc.runtime, {
    address: running.address,
    recordDirectory: hc.root,
    timeoutSeconds: runningWaitTimeoutSeconds,
  }).catch((error: unknown) => error);

  await endReviewTerminal(hc.runtime, running.address);

  expect(failure).toBeInstanceOf(TuicrExitTimeoutError);
});
