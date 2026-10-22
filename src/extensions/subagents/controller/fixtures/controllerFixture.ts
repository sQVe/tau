import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi, onTestFinished as afterTest } from 'vitest';
import type { MockInstance } from 'vitest';

import { herdrFake } from '../../../../../tests/herdrFake.js';
import * as cancellationModule from '../../cancellation.js';
import { fixtureLoadout } from '../../fixtures/loadout.js';
import * as loadoutModule from '../../loadout.js';
import type { WorkerNotice } from '../../presentation.js';
import { readTask, recordEvent } from '../../records.js';
import * as records from '../../records.js';
import type { Loadout } from '../../types.js';
import { WorkerController } from '../controller.js';
import type { HerdrClient } from '../inspect.js';
import type { WorkerPackageManager } from '../packageInstall.js';

interface SetupFixture {
  directory: string;
  controller: WorkerController;
  client: HerdrClient;
  fake: ReturnType<typeof herdrFake>;
  calls: string[][];
  notifications: WorkerNotice[];
  input: {
    task: string;
    loadout: Loadout;
    timeout: number;
    parentSession: string;
    parentSessionId: string;
    parentPane: string;
  };
}

interface CompletedFixture extends Omit<SetupFixture, 'input'> {
  validation: MockInstance<typeof loadoutModule.validateSavedLoadout>;
  context: Parameters<typeof loadoutModule.validateSavedLoadout>[1];
  input: {
    task: string;
    sourceTaskId: string;
    acceptance: string[];
    timeout: number;
    parentSession: string;
    parentSessionId: string;
    parentPane: string;
  };
  source: ReturnType<typeof readTask>;
  sourceDirectory: string;
}

const originalRunClient = cancellationModule.runClient;

export const captureError = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the action to throw.');
};

export const setup = (
  onTestFinished: (callback: () => void) => void,
  readyDelay = 0,
  intercept?: HerdrClient,
  packageManager?: (loadout: Loadout) => WorkerPackageManager,
  capacity?: number,
): SetupFixture => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-controller-'));

  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  writeFileSync(
    join(directory, 'parent.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent-id', cwd: directory })}\n`,
  );

  const fake = herdrFake();

  vi.spyOn(cancellationModule, 'runClient').mockImplementation(
    (executable, argumentsList, budget, options) => {
      if (executable === 'ps' && fake.knowsProcess(Number(argumentsList[1]))) {
        return Promise.resolve('fixture shell start');
      }

      return originalRunClient(executable, argumentsList, budget, options);
    },
  );

  const originalProcessAbsent = cancellationModule.processAbsent;

  vi.spyOn(cancellationModule, 'processAbsent').mockImplementation((processId) =>
    fake.knowsProcess(processId) ? fake.processAbsent(processId) : originalProcessAbsent(processId),
  );

  const calls: string[][] = [];
  let startAttempted = false;

  const client: HerdrClient = async (argumentsList, budget, signal) => {
    calls.push(argumentsList);

    if (argumentsList[0] === 'layout' || argumentsList[1] === 'start') {
      startAttempted = true;
    }

    if (argumentsList[1] === 'process-info' && !startAttempted) {
      return fake.client(argumentsList, budget, signal);
    }

    if (intercept) {
      const response = await intercept(argumentsList, budget, signal);

      if (response) {
        return response;
      }
    }

    // Placement starts a Pi worker as its pane's own process.
    if (argumentsList[0] === 'layout') {
      const root = (
        JSON.parse(argumentsList[2] ?? '') as {
          root: { command: string[]; env: Record<string, string> };
        }
      ).root;

      const recordDirectory = root.env.TAU_WORKER_RECORD ?? '';
      const task = readTask(recordDirectory);
      const response = await fake.client(argumentsList, budget, signal);
      const processId = fake.workers().at(-1)!.processId;

      const ready = () => {
        recordEvent(recordDirectory, task.taskId, 'ready', {
          detail: 'Ready.',
          processId,
        });
      };

      if (readyDelay > 0) {
        setTimeout(ready, readyDelay);
      } else if (readyDelay === 0) {
        ready();
      }

      return response;
    }

    return fake.client(argumentsList, budget, signal);
  };

  const notifications: WorkerNotice[] = [];

  const controller = new WorkerController(
    directory,
    client,
    (notice) => notifications.push(notice),
    packageManager,
    capacity,
  );

  onTestFinished(() => {
    controller.close();
  });

  const input = {
    task: 'Edit fixture and test it.',
    loadout: fixtureLoadout(directory),
    timeout: 10_000,
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent-id',
    parentPane: 'parent',
  };

  return { directory, controller, client, fake, calls, notifications, input };
};

export const savedFiles = (directory: string): { path: string; bytes: Buffer | undefined }[] => {
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });

  return entries.map((entry) => {
    const path = join(entry.parentPath, entry.name);
    const bytes = entry.isFile() ? readFileSync(path) : undefined;

    return { path, bytes };
  });
};

export const completed = async (
  intercept?: HerdrClient,
  packages?: { manager: (loadout: Loadout) => WorkerPackageManager; sources: string[] },
): Promise<CompletedFixture> => {
  const fixture = setup(afterTest, 0, intercept, packages?.manager);

  fixture.input.loadout = { ...fixture.input.loadout, packages: packages?.sources ?? [] };

  writeFileSync(
    fixture.input.parentSession,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: fixture.input.parentSessionId,
      cwd: fixture.directory,
    }) + '\n',
  );

  const status = await fixture.controller.launch(fixture.input);

  records.acceptReport(status.directory, status.taskId, {
    taskId: status.taskId,
    outcome: 'success',
    summary: 'Finished.',
    evidence: ['Checked.'],
  });

  recordEvent(status.directory, status.taskId, 'settled', {
    detail: 'Worker settled.',
    stopped: true,
  });

  recordEvent(status.directory, status.taskId, 'cleanup', {
    detail: 'Parent confirmed exit.',
    stopped: true,
  });

  fixture.controller.close();

  const controller = new WorkerController(
    fixture.directory,
    fixture.client,
    undefined,
    packages?.manager,
  );

  afterTest(() => {
    controller.close();
  });

  const validation = vi
    .spyOn(loadoutModule, 'validateSavedLoadout')
    .mockImplementation((value) => value as ReturnType<typeof readTask>['loadout']);

  const context = { cwd: fixture.directory, isProjectTrusted: () => true } as Parameters<
    typeof loadoutModule.validateSavedLoadout
  >[1];

  const input = {
    task: 'Follow up within saved settings.',
    sourceTaskId: status.taskId,
    acceptance: ['Follow-up is done.'],
    timeout: 12000,
    parentSession: fixture.input.parentSession,
    parentSessionId: fixture.input.parentSessionId,
    parentPane: fixture.input.parentPane,
  };

  return {
    ...fixture,
    controller,
    validation,
    context,
    input,
    source: readTask(status.directory),
    sourceDirectory: status.directory,
  };
};
