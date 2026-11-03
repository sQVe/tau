import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { startHcSession } from './hcSessionHarness.js';
import {
  followUpWorkerSession,
  launchWorkerSession,
  waitForReport,
  waitForTerminalFinished,
} from './subagentSessionHarness.js';

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

vi.setConfig({ testTimeout: 120_000 });

it('resumes an ended worker with its first task in context', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel, firstTaskMarker, followUpTaskMarker } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: `Edit source.txt ${firstTaskMarker}`,
    acceptance: ['source.txt says after.'],
    prepareWorker: (workerDirectory) => {
      writeFileSync(join(workerDirectory, 'source.txt'), 'before\n');
      mkdirSync(join(workerDirectory, 'delete-fixture', '.git'), { recursive: true });
      writeFileSync(join(workerDirectory, 'delete-fixture', '.git', 'keep'), 'preserve');
    },
  });

  const first = await waitForReport(worker.assignmentFilePath);

  expect(first.report?.outcome).toBe('success');

  await waitForTerminalFinished(hc, worker.workerAddress);

  const followUp = await followUpWorkerSession({
    source: worker,
    task: `Continue the work ${followUpTaskMarker}`,
    acceptance: ['The follow-up reports the first task context.'],
  });

  const second = await waitForReport(followUp.assignmentFilePath);

  expect(second.previousAssignmentId).toBe(first.assignmentId);
  expect(second.session.file).toBe(first.session.file);
  expect(second.report?.evidence ?? []).toContain('first task in context: true');
});
