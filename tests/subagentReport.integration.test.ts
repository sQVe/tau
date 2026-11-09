import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { DeadlineWatchdog } from '../src/extensions/subagents/deadlineWatchdog.js';
import { createEventWatch } from '../src/extensions/subagents/eventWatch.js';
import { createWorkerDelivery } from '../src/extensions/subagents/workerDelivery.js';
import { reportMessageType } from '../src/extensions/subagents/workerMessage.js';
import { createWorkerScan } from '../src/extensions/subagents/workerScan.js';
import type { WorkerScan } from '../src/extensions/subagents/workerScan.js';
import { subscribeEvents } from '../src/hc/events.js';
import { get } from '../src/hc/hc.js';
import type { HcSession } from './hcSessionHarness.js';
import { startHcSession } from './hcSessionHarness.js';
import {
  launchWorkerSession,
  managerSessionFile,
  waitForReport,
} from './subagentSessionHarness.js';

interface SentReportMessage {
  customType?: unknown;
  content?: unknown;
  details?: unknown;
}

interface SessionEntry {
  type: string;
  customType: string;
  details?: unknown;
}

type DeliveryContext = Parameters<ReturnType<typeof createWorkerDelivery>['deliver']>[0];

vi.setConfig({ testTimeout: 120_000 });

const noDeadline: DeadlineWatchdog = { apply: () => Promise.resolve(), clear: () => undefined };

const recordingManager = () => {
  const messages: SentReportMessage[] = [];
  const entries: SessionEntry[] = [];

  const pi = {
    on: () => undefined,
    sendMessage: (message: { customType: string; details: unknown }) => {
      messages.push(message);

      entries.push({
        type: 'custom_message',
        customType: message.customType,
        details: message.details,
      });
    },
  } as unknown as ExtensionAPI;

  const context = {
    sessionManager: { getEntries: () => entries, getSessionFile: () => managerSessionFile },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  } as unknown as DeliveryContext;

  return { pi, messages, entries, context };
};

const waitForReportMessage = async (messages: readonly SentReportMessage[]): Promise<void> => {
  const deadline = Date.now() + 90_000;

  while (messages.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('The event watch never delivered the worker report.');
    }

    await delay(100);
  }
};

const managerProbe = `
import { appendFileSync } from 'node:fs';

const output = process.argv[2];

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  appendFileSync(output, JSON.stringify({ typed: chunk }) + '\\n');
});
`;

const waitForTerminalLabel = async (
  hc: HcSession,
  address: string,
  key: string,
  value: string,
): Promise<void> => {
  const deadline = Date.now() + 90_000;

  for (;;) {
    const terminal = await get(hc.runtime, address);

    if (terminal.labels?.[key] === value) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`Worker never set ${key} on ${address}.`);
    }

    await delay(100);
  }
};

it('shows a real worker report once before it gives the worker the manager environment', async () => {
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

  await waitForTerminalLabel(hc, worker.workerAddress, 'tau.report', worker.assignmentFilePath);

  expect(worker.managerPath).not.toBe(hc.environment['PATH']);
  expect(evidence).toContain(`PATH: ${worker.managerPath}`);
  expect(evidence).toContain(`PI_CODING_AGENT_DIR: ${worker.agentDirectory}`);
  expect(evidence).toContain('TAU_ROLE: worker');
  expect(evidence).toContain('APPEND_SYSTEM.md: true');

  const { pi, messages, entries, context: deliveryContext } = recordingManager();

  await createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline).scan(deliveryContext);
  await createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline).scan(deliveryContext);

  expect(messages).toHaveLength(1);
  expect(entries).toHaveLength(1);

  await delay(500);

  expect(existsSync(worker.observationPath)).toBe(false);
});

it('delivers one worker report through the real hc event watch', async () => {
  const hc = await startHcSession(onTestFinished);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, value] of Object.entries(hc.environment)) {
    vi.stubEnv(name, value);
  }

  vi.resetModules();

  const { fixtureModel } =
    await import('../src/extensions/subagents/fixtures/controlledProvider.js');

  const { pi, messages, context } = recordingManager();
  const scan = createWorkerScan(hc.runtime, createWorkerDelivery(pi), noDeadline);

  const readiness = Promise.withResolvers<undefined>();
  let completedScans = 0;

  const trackedScan: WorkerScan = {
    scan: async (scanContext) => {
      await scan.scan(scanContext);

      completedScans += 1;
      readiness.resolve(undefined);
    },
    clear: () => {
      scan.clear();
    },
  };

  const watch = createEventWatch(subscribeEvents, trackedScan);

  onTestFinished(() => {
    watch.stop();
    scan.clear();
  });

  const worker = await launchWorkerSession({
    hc,
    model: fixtureModel,
    task: 'Edit source.txt and report.',
    acceptance: ['source.txt says after.'],
    probe: { source: managerProbe },
    prepareWorker: (workerDirectory) => {
      writeFileSync(join(workerDirectory, 'source.txt'), 'before\n');
    },
    beforeLaunch: async () => {
      watch.start(context);
      await readiness.promise;

      expect(messages).toHaveLength(0);
    },
  });

  if (worker.observationPath === undefined) {
    throw new Error('The fixture worker got no manager probe.');
  }

  await waitForReportMessage(messages);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ customType: reportMessageType });
  expect(completedScans).toBeGreaterThan(1);
  expect(existsSync(worker.observationPath)).toBe(false);
});
