import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { DeadlineWatchdog } from '../src/extensions/subagents/deadlineWatchdog.js';
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { createWorkerScan } from '../src/extensions/subagents/workerScan.js';
import { startHcSession } from './hcSessionHarness.js';
import {
  launchWorkerSession,
  waitForObservation,
  waitForReport,
} from './subagentSessionHarness.js';

vi.mock(import('../src/extensions/subagents/loadout.js'), { spy: true });

vi.setConfig({ testTimeout: 120_000 });

const noDeadline: DeadlineWatchdog = { apply: () => Promise.resolve(), clear: () => undefined };

const managerProbe = `
import { appendFileSync, readFileSync } from 'node:fs';

const output = process.argv[2];
const marker = '[tau-report]';
let buffer = '';
let observed = false;

const observe = () => {
  if (observed) return;
  const at = buffer.indexOf(marker);
  if (at < 0) return;
  const match = buffer.slice(at + marker.length).match(/\\/\\S+/);
  if (match === null) return;
  const path = match[0].replace(/[^A-Za-z0-9/_.-].*$/s, '');
  let report = false;
  try {
    report = JSON.parse(readFileSync(path, 'utf8')).report != null;
  } catch {
    return;
  }
  appendFileSync(output, JSON.stringify({ path, report }) + '\\n');
  observed = true;
  process.exit(0);
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  observe();
});
`;

it('shows a real worker report once before it gives the worker the manager environment', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HC_SESSION', hc.session);

  vi.resetModules();

  const { fixtureModel } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: 'Edit source.txt and report.',
    acceptance: ['source.txt says after.'],
    probe: { source: managerProbe },
    prepareWorker: (workerDirectory) => {
      writeFileSync(join(workerDirectory, 'source.txt'), 'before\n');
      mkdirSync(join(workerDirectory, 'delete-fixture', '.git'), { recursive: true });
      writeFileSync(join(workerDirectory, 'delete-fixture', '.git', 'keep'), 'preserve');
    },
  });

  const assignment = await waitForReport(worker.assignmentFilePath);
  const evidence = assignment.report?.evidence ?? [];

  if (worker.observationPath === undefined) {
    throw new Error('The fixture worker got no manager probe.');
  }

  const observation = await waitForObservation(worker.observationPath);

  expect(observation.path).toBe(worker.assignmentFilePath);
  expect(observation.report).toBe(true);

  expect(worker.managerPath).not.toBe(hc.environment['PATH']);
  expect(evidence).toContain(`PATH: ${worker.managerPath}`);
  expect(evidence).toContain(`PI_CODING_AGENT_DIR: ${worker.agentDirectory}`);
  expect(evidence).toContain('TAU_ROLE: worker');
  expect(evidence).toContain('APPEND_SYSTEM.md: true');

  const messages: unknown[] = [];
  const entries: { type: string; customType: string; details?: unknown }[] = [];

  const pi = {
    sendMessage: (message: { customType: string; details: unknown }) => {
      messages.push(message);

      entries.push({
        type: 'custom_message',
        customType: message.customType,
        details: message.details,
      });
    },
  } as unknown as ExtensionAPI;

  const deliveryContext = {
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
  } as unknown as Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

  await createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline).scan(deliveryContext);
  await createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline).scan(deliveryContext);

  expect(messages).toHaveLength(1);
  expect(entries).toHaveLength(1);
});
