import { expect, it, onTestFinished, vi } from 'vitest';

import { startHcSession } from './hcSessionHarness.js';
import { launchWorkerSession, waitForReport } from './subagentSessionHarness.js';

vi.setConfig({ testTimeout: 120_000 });

const exitBeforeReporting = { source: 'process.exit(1);\n' };

it('reports that the worker ended instead of waiting for its report', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: 'Exit before reporting.',
    acceptance: ['Nothing is needed.'],
    command: exitBeforeReporting,
  });

  const failure: unknown = await waitForReport(worker).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(worker.workerAddress);
  expect(String(failure)).toContain('exit code 1');
});
