import { expect, it, vi } from 'vitest';

import { openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { openArchitect } from './open.js';

// The checkout probe is the only launch step that runs before the terminal starts, so it is where a
// cancellation can arrive without a terminal to report.
const gitProbe = vi.hoisted(() => ({ abort: (): void => undefined }));

vi.mock(import('../../../git.js'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    isGitRepository: async (): Promise<boolean> => {
      gitProbe.abort();

      return true;
    },
  };
});

it('reports the caller cancellation when an abort lands during the launch checkout probe', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const reason = 'cancelled during the checkout probe';

  gitProbe.abort = () => {
    controller.abort(reason);
  };

  await recordSession(root);

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('The open was cancelled.');
  expect((failure as Error).cause).toBe(reason);
});
