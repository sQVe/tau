import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { readTask, recordEvent } from '../records.js';
import { WorkerController } from './controller.js';
import { completed, setup } from './fixtures/controllerFixture.js';
import type { WorkerPackageManager } from './packageInstall.js';
import { EvidenceUnavailableError } from './record.js';

const installedPackages = (sources: string[]) => ({
  extensions: sources.map((path) => ({
    path,
    enabled: true,
    metadata: { source: path, scope: 'temporary' as const, origin: 'package' as const },
  })),
  skills: [],
  prompts: [],
  themes: [],
});

const packageManager = (): WorkerPackageManager => ({
  listConfiguredPackages: () => [],
  resolveExtensionSources: (sources) => Promise.resolve(installedPackages(sources)),
});

it('saves no acceptance criteria for a launch that gives none', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);

  const launched = await controller.launch(input);

  expect(readTask(launched.directory).acceptance).toBeUndefined();
});

it('saves the routing decision of a routed launch', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const routing = { shadowPick: 'faux/test', canary: false, ticketSent: true };

  const launched = await controller.launch({ ...input, routing });

  expect(readTask(launched.directory).routing).toEqual(routing);
});

it.each(['0', '-1', '1.5', '257', 'many', ''])('refuses TAU_SUBAGENT_CAP=%j', (capacity) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', capacity);

  expect(() => new WorkerController('/tmp/tau-no-workers')).toThrow('TAU_SUBAGENT_CAP');
  vi.unstubAllEnvs();
});

it.each(['1', '4', '256'])('accepts TAU_SUBAGENT_CAP=%s', (capacity) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', capacity);

  expect(() => new WorkerController('/tmp/tau-no-workers')).not.toThrow();
  vi.unstubAllEnvs();
});

it('lists only the workers of the asked parent session in the widget', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const own = await controller.launch(input);
  const other = await controller.launch({ ...input, parentSessionId: 'other-parent' });

  expect(controller.widgetRows('parent-id').map((row) => row.taskId)).toEqual([own.taskId]);
  expect(controller.widgetRows('other-parent').map((row) => row.taskId)).toEqual([other.taskId]);
});

it('refuses a receipt for a question the worker never asked', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  expect(() => controller.questionReceipt(launched.taskId, 'parent-id', 'never-asked')).toThrow(
    'Unknown worker question',
  );
});

it('refuses a reply to a worker that already settled', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');
  recordEvent(launched.directory, launched.taskId, 'settled', { detail: 'Done.', stopped: true });

  expect(() =>
    controller.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
    }),
  ).toThrow('inactive');
});

it('reports an unreadable task record with its task identity and recovery directory', ({
  onTestFinished,
}) => {
  const { controller, directory } = setup(onTestFinished);
  const taskId = 'corrupt-task';

  mkdirSync(join(directory, taskId));
  writeFileSync(join(directory, taskId, 'task.json'), '{');

  let failure: unknown;

  try {
    controller.status(taskId, 'parent-id');
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(EvidenceUnavailableError);
  expect(failure).toMatchObject({ taskId, recovery: { directory: join(directory, taskId) } });
});

it('names the worker in a status whose evidence is unreadable', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const task = readTask(launched.directory);

  writeFileSync(join(launched.directory, 'report.json'), '{');

  let failure: unknown;

  try {
    controller.status(launched.taskId, 'parent-id');
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(EvidenceUnavailableError);
  expect(failure).toMatchObject({ taskId: launched.taskId, taskName: task.name });
});

it('lists the live agents once for a launch that installs packages', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished, 0, undefined, packageManager);
  const loadout = { ...input.loadout, packages: ['npm:pi-codex-image-gen'] };

  await controller.launch({ ...input, loadout });

  expect(calls.filter((call) => call[0] === 'agent' && call[1] === 'list')).toHaveLength(1);
});

it('starts no follow-up worker when its source task changed during validation', async () => {
  const tamper: { run?: () => void } = {};

  const fixture = await completed(async (argumentsList) => {
    if (argumentsList[0] === 'agent' && argumentsList[1] === 'list') {
      tamper.run?.();
    }

    return '';
  });

  const starts = () => fixture.calls.filter((call) => call[0] === 'layout').length;
  const startsBefore = starts();
  const path = join(fixture.sourceDirectory, 'task.json');

  tamper.run = () => {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    writeFileSync(path, JSON.stringify({ ...saved, task: 'A task changed after validation.' }));
  };

  await fixture.controller.followUp(fixture.input, fixture.context);

  expect(starts()).toBe(startsBefore);
});

it('closes the pane of a launch whose pane lookup failed after herdr started it', async ({
  onTestFinished,
}) => {
  let lookups = 0;

  const { controller, input, calls } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[0] === 'pane' && argumentsList[1] === 'get') {
      lookups += 1;

      if (lookups === 1) {
        throw new Error('pane lookup failed');
      }
    }

    return '';
  });

  await controller.launch(input);

  const lookedUp = calls.filter((call) => call[0] === 'pane' && call[1] === 'get');

  expect(lookedUp).toHaveLength(2);
  expect(lookedUp[1]).toEqual(lookedUp[0]);
  expect(calls).toContainEqual(['pane', 'close', lookedUp[0]![2]]);
});
