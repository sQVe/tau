import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as cancellation from './cancellation.js';
import { claudeChannelSocket, claudeToolName } from './claude.js';
import { WorkerController } from './controller.js';
import type { HerdrClient } from './controller.js';
import { channelCall, channelHook } from './fixtures/channelClient.js';
import { claudeConfigurationFixture } from './fixtures/claudeConfiguration.js';
import { fixtureClaudeLoadout } from './fixtures/loadout.js';
import * as identity from './identity.js';
import { resolveClaudeLoadout } from './loadout.js';
import { workerPrompt } from './profiles.js';
import { readEvent, readTask, readTasks, recordEvent } from './records.js';

const setup = (options: { ready?: boolean } = {}) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tau-claude-controller-')));
  afterTest(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });
  // The fake worker uses this test process; the parent must have a distinct identity.
  vi.spyOn(identity, 'currentProcessIdentity').mockResolvedValue({
    processId: process.pid + 1,
    startedAt: 'fixture parent',
  });
  writeFileSync(
    join(directory, 'parent.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent-id', cwd: directory })}\n`,
  );
  const calls: string[][] = [];
  let recordDirectory = '';
  const nativeSession = () => (recordDirectory ? readTask(recordDirectory).nativeSessionId : '');

  const client: HerdrClient = (arguments_) => {
    calls.push(arguments_);
    const parent = {
      pane_id: 'parent-pane',
      terminal_id: 'parent-terminal',
      workspace_id: 'workspace',
      tab_id: 'tab',
    };
    const owned = {
      pane_id: 'owned-pane',
      terminal_id: 'owned-terminal',
      workspace_id: 'workspace',
      tab_id: 'tab',
    };
    if (arguments_[1] === 'current') {
      return Promise.resolve(JSON.stringify({ result: { pane: parent } }));
    }
    if (arguments_[1] === 'list' && arguments_[0] === 'pane') {
      return Promise.resolve(JSON.stringify({ result: { panes: [parent, owned] } }));
    }
    if (arguments_[1] === 'layout') {
      return Promise.resolve(
        JSON.stringify({
          result: {
            layout: {
              workspace_id: 'workspace',
              tab_id: 'tab',
              zoomed: false,
              area: { width: 200, height: 60 },
              panes: [{ pane_id: parent.pane_id, rect: { width: 200, height: 60 } }],
            },
          },
        }),
      );
    }
    if (arguments_[0] === 'agent' && arguments_[1] === 'list') {
      return Promise.resolve(JSON.stringify({ result: { type: 'agent_list', agents: [] } }));
    }
    if (arguments_[1] === 'split') {
      recordDirectory =
        arguments_
          .find((argument) => argument.startsWith('TAU_WORKER_RECORD='))
          ?.slice('TAU_WORKER_RECORD='.length) ?? '';

      return Promise.resolve(JSON.stringify({ result: { pane: owned } }));
    }
    if (arguments_[1] === 'run' && options.ready !== false) {
      // Stand in for the worker's own SessionStart hook reaching the parent channel.
      const task = readTask(recordDirectory);
      recordEvent(recordDirectory, task.taskId, 'ready', 'Fixture readiness.', false, process.pid);
    }
    if (arguments_[1] === 'process-info') {
      return Promise.resolve(
        JSON.stringify({
          result: {
            process_info: {
              pane_id: 'owned-pane',
              shell_pid: 100,
              foreground_process_group_id: process.pid,
              foreground_processes: [
                { pid: process.pid, argv: ['claude', '--session-id', nativeSession()] },
              ],
            },
          },
        }),
      );
    }
    if (arguments_[1] === 'get') {
      return Promise.resolve(
        JSON.stringify({
          result: {
            agent: {
              pane_id: 'owned-pane',
              agent: 'claude',
              agent_session: { kind: 'id', value: nativeSession() },
            },
          },
        }),
      );
    }

    return Promise.resolve(JSON.stringify({ result: {} }));
  };

  const records = join(directory, 'records');
  mkdirSync(records, { recursive: true });
  const notifications: string[] = [];
  const controller = new WorkerController(records, client, (message) => {
    notifications.push(message);
  });
  controller.project = { cwd: directory, isProjectTrusted: () => true };
  afterTest(() => {
    controller.close();
  });

  const loadout = fixtureClaudeLoadout(directory);

  return {
    directory,
    records,
    controller,
    calls,
    notifications,
    loadout,
    input: {
      task: 'Edit the fixture and check it.',
      loadout,
      timeout: 10_000,
      parentSession: join(directory, 'parent.jsonl'),
      parentSessionId: 'parent-id',
      parentPane: 'parent-pane',
    },
  };
};

it('starts a Claude worker with the canonical command and dispatches its task', async () => {
  const fixture = setup();

  const launched = await fixture.controller.launch(fixture.input);

  const run = fixture.calls.find((call) => call[1] === 'run');
  expect(run?.slice(0, 5)).toEqual([
    'pane',
    'run',
    'owned-pane',
    'command',
    fixture.loadout.executable,
  ]);
  expect(fixture.calls.some((call) => call[1] === 'start')).toBe(false);
  expect(launched.ready).toBe(true);
  expect(launched.harness).toBe('claude');

  const prompt = fixture.calls.find((call) => call[1] === 'prompt');
  expect(prompt?.[3]).toContain(fixture.loadout.instructions);
  expect(prompt?.[3]).toContain(launched.taskId);
  expect(prompt?.[3]).toContain(claudeToolName('subagent_report'));
});

it('never dispatches work to a Claude worker that does not reach readiness', async () => {
  const fixture = setup({ ready: false });
  vi.useFakeTimers();
  vi.spyOn(cancellation, 'runClient').mockResolvedValue('fixture process start');

  const launching = fixture.controller.launch(fixture.input);
  await vi.advanceTimersByTimeAsync(fixture.input.timeout);
  const launched = await launching;

  expect(launched.ready).toBe(false);
  expect(launched.outcome).toBe('timeout');
  expect(fixture.calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(readEvent(launched.directory, launched.taskId, 'accepted')).toBeUndefined();
});

it('interrupts a Claude worker through its terminal when cancelled', async () => {
  const fixture = setup();
  const launched = await fixture.controller.launch(fixture.input);

  const cancelled = await fixture.controller.cancel(launched.taskId, 'parent-id');

  expect(cancelled.outcome).toBe('cancelled');
  const keys = fixture.calls.find((call) => call[1] === 'send-keys');
  expect(keys).toEqual(['pane', 'send-keys', 'owned-pane', 'ctrl+c']);
});

it('writes the settings and channel configuration the worker launches with', async () => {
  const fixture = setup();

  const launched = await fixture.controller.launch(fixture.input);

  const settings: unknown = JSON.parse(
    readFileSync(join(launched.directory, 'claudeSettings.json'), 'utf8'),
  );
  const mcp: unknown = JSON.parse(readFileSync(join(launched.directory, 'claudeMcp.json'), 'utf8'));
  expect(JSON.stringify(settings)).toContain('SessionStart');
  expect(JSON.stringify(settings)).toContain(fixture.loadout.channelScript);
  expect(JSON.stringify(mcp)).toContain('channel.sock');
});

// Nested delegation resolves a real inherited loadout, so the worker needs a real saved configuration.
const nestedSetup = async () => {
  const fixture = setup();
  const configuration = claudeConfigurationFixture(fixture.directory);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configuration.configuration);
  mkdirSync(join(fixture.directory, 'agent'), { recursive: true });
  vi.stubEnv('PI_CODING_AGENT_DIR', join(fixture.directory, 'agent'));
  vi.stubEnv('PATH', `${configuration.binary}:${process.env.PATH ?? ''}`);
  const loadout = await resolveClaudeLoadout(
    { profile: 'claude-worker', model: 'claude-tau-fixture', permissions: 'trusted-full-tools' },
    { cwd: fixture.directory, isProjectTrusted: () => true },
  );
  const launched = await fixture.controller.launch({ ...fixture.input, loadout });
  const socket = claudeChannelSocket(launched.directory);
  const task = readTask(launched.directory);
  const accepted = await channelHook(socket, 'UserPromptSubmit', {
    session_id: task.nativeSessionId,
    prompt: workerPrompt(task),
    permission_mode: 'bypassPermissions',
  });
  expect(accepted.code).toBe(0);

  return { ...fixture, launched, socket };
};

it('delegates a nested Claude worker through the worker channel', async () => {
  const fixture = await nestedSetup();

  const delegated = await channelCall(fixture.socket, 'subagent', {
    task: 'Check one file inside the assigned scope.',
    profile: 'claude-scout',
    timeoutSeconds: 60,
  });

  const answer = JSON.stringify(delegated);
  expect(answer).not.toContain('isError');
  const child = readTasks(fixture.records).find(
    (entry) => entry.task.taskId !== fixture.launched.taskId,
  );
  expect(child?.task.tree?.parentTaskId).toBe(fixture.launched.taskId);
  expect(child?.task.parentSessionId).toBe(readTask(fixture.launched.directory).nativeSessionId);
  expect(child?.task.loadout.instructions).toContain(readTask(fixture.launched.directory).task);
  expect(child?.task.name?.startsWith('investigator-')).toBe(true);
}, 30_000);

it('cleans up a nested worker when its parent stops', async () => {
  const fixture = await nestedSetup();
  await channelCall(fixture.socket, 'subagent', {
    task: 'Check one file inside the assigned scope.',
    profile: 'claude-scout',
    timeoutSeconds: 60,
  });
  const child = readTasks(fixture.records).find(
    (entry) => entry.task.taskId !== fixture.launched.taskId,
  );

  await fixture.controller.cancel(fixture.launched.taskId, 'parent-id');

  expect(readEvent(child!.directory, child!.task.taskId, 'cancelled')).toBeDefined();
  expect(readEvent(child!.directory, child!.task.taskId, 'cleanup')).toBeDefined();
}, 30_000);

it('refuses nested delegation when the tree has no capacity left', async () => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');
  const fixture = await nestedSetup();

  const refused = await channelCall(fixture.socket, 'subagent', {
    task: 'Check one file inside the assigned scope.',
    profile: 'claude-scout',
    timeoutSeconds: 60,
  });

  expect(JSON.stringify(refused)).toContain('capacity full');
  expect(readTasks(fixture.records)).toHaveLength(1);
}, 30_000);
