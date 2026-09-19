import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest } from 'vitest';

import { claudeChannelSocket, claudeToolName } from './claude.js';
import { ClaudeChannel } from './claudeHost.js';
import type { ChannelTool } from './claudeHost.js';
import { channelCall, channelHook } from './fixtures/channelClient.js';
import { fixtureClaudeLoadout } from './fixtures/loadout.js';
import { claudeIntegrationFingerprint } from './loadout.js';
import { publish, readEvent, readPendingQuestion, readReport, validateTask } from './records.js';
import type { Task } from './types.js';

const denyingSafety = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }));`;

const setup = async (
  options: {
    delegation?: () => ChannelTool[];
    children?: () => { active: number; uncertain: string[] };
    integrations?: string[];
  } = {},
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-channel-'));
  const safety = join(directory, 'safety.js');
  writeFileSync(safety, denyingSafety);
  chmodSync(safety, 0o700);
  const base = fixtureClaudeLoadout(directory);
  const integrations = [safety, ...(options.integrations ?? [])];
  const loadout = {
    ...base,
    cwd: directory,
    safetyExtension: safety,
    integrations,
    integrationFingerprint: claudeIntegrationFingerprint(integrations),
  };
  const task: Task = validateTask({
    version: 1,
    taskId: 'task-one',
    task: 'Edit the fixture.',
    parentSession: join(directory, 'parent.jsonl'),
    parentSessionId: 'parent',
    ownerId: 'owner',
    nativeSessionId: '11111111-2222-3333-4444-555555555555',
    nativeSessionFile: join(directory, 'transcript.jsonl'),
    createdAt: 1,
    deadline: 600_000,
    cancellationBudget: 5000,
    loadout,
  });
  publish(directory, 'task.json', task);
  const socketPath = claudeChannelSocket(directory);
  const channel = new ClaudeChannel({
    directory,
    task,
    socketPath,
    ...(options.delegation ? { delegation: options.delegation } : {}),
    children: options.children ?? (() => ({ active: 0, uncertain: [] })),
  });
  await channel.listen();
  afterTest(() => {
    channel.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const hook = (event: string, payload: Record<string, unknown>, claudePid = process.pid) =>
    channelHook(socketPath, event, { session_id: task.nativeSessionId, ...payload }, claudePid);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    channelCall(socketPath, name, input);

  const started = () =>
    hook('SessionStart', {
      transcript_path: task.nativeSessionFile,
      cwd: loadout.cwd,
      source: 'startup',
      hook_event_name: 'SessionStart',
    });
  const dispatched = async (prompt = 'Do the fixture task.') => {
    publish(directory, 'dispatch.json', { taskId: task.taskId, prompt });
    await started();

    return hook('UserPromptSubmit', { prompt, permission_mode: 'bypassPermissions' });
  };

  return { directory, task, channel, hook, call, started, dispatched, socketPath };
};

const text = (result: Record<string, unknown>): string => JSON.stringify(result);

it('records readiness only after Claude proves its own session and safety integration', async () => {
  const fixture = await setup();

  const accepted = await fixture.started();

  expect(accepted.code).toBe(0);
  const ready = readEvent(fixture.directory, fixture.task.taskId, 'ready');
  expect(ready?.processId).toBe(process.pid);
  expect(ready?.detail).toContain('CC Safety Net denied');
});

it('refuses a Claude session that does not match its saved task', async () => {
  const fixture = await setup();

  const wrong = await fixture.hook('SessionStart', {
    session_id: 'another-session',
    transcript_path: fixture.task.nativeSessionFile,
    cwd: fixture.task.loadout.cwd,
    source: 'startup',
  });

  expect(wrong.code).toBe(2);
  expect(wrong.stderr).toContain('does not match the saved task');
  expect(readEvent(fixture.directory, fixture.task.taskId, 'ready')).toBeUndefined();
  expect(readEvent(fixture.directory, fixture.task.taskId, 'startupFailure')?.detail).toContain(
    'does not match the saved task',
  );
});

it('refuses a worker whose transcript or working directory moved', async () => {
  const fixture = await setup();

  const moved = await fixture.hook('SessionStart', {
    transcript_path: join(fixture.directory, 'elsewhere.jsonl'),
    cwd: fixture.task.loadout.cwd,
    source: 'startup',
  });

  expect(moved.code).toBe(2);
  expect(readEvent(fixture.directory, fixture.task.taskId, 'ready')).toBeUndefined();
});

it('accepts only the exact dispatched task as the start of work', async () => {
  const fixture = await setup();
  publish(fixture.directory, 'dispatch.json', {
    taskId: fixture.task.taskId,
    prompt: 'Do the fixture task.',
  });
  await fixture.started();

  const other = await fixture.hook('UserPromptSubmit', {
    prompt: 'Do something else entirely.',
    permission_mode: 'bypassPermissions',
  });
  expect(other.code).toBe(2);
  expect(other.stderr).toContain('not the task the parent dispatched');
  expect(readEvent(fixture.directory, fixture.task.taskId, 'accepted')).toBeUndefined();

  const dispatched = await fixture.hook('UserPromptSubmit', {
    prompt: 'Do the fixture task.',
    permission_mode: 'bypassPermissions',
  });
  expect(dispatched.code).toBe(0);
  expect(readEvent(fixture.directory, fixture.task.taskId, 'accepted')?.detail).toContain(
    'Claude submitted the dispatched task',
  );
});

it('refuses a worker whose runtime permission mode is not the recorded one', async () => {
  const fixture = await setup();
  publish(fixture.directory, 'dispatch.json', {
    taskId: fixture.task.taskId,
    prompt: 'Do the fixture task.',
  });
  await fixture.started();

  const prompted = await fixture.hook('UserPromptSubmit', {
    prompt: 'Do the fixture task.',
    permission_mode: 'acceptEdits',
  });

  expect(prompted.code).toBe(2);
  expect(prompted.stderr).toContain('permission mode acceptEdits');
  expect(readEvent(fixture.directory, fixture.task.taskId, 'startupFailure')).toBeDefined();
  expect(readEvent(fixture.directory, fixture.task.taskId, 'accepted')).toBeUndefined();
});

it('accepts a parent reply once and refuses unmatched delivery', async () => {
  const fixture = await setup();
  await fixture.dispatched();
  const asked = await fixture.call('subagent_question', {
    question: 'May I edit the fixture?',
  });
  const questionId = readPendingQuestion(fixture.directory, fixture.task.taskId)?.questionId ?? '';
  expect(text(asked)).toContain('Question saved for the parent');

  publish(fixture.directory, `reply-${questionId}.json`, {
    version: 1,
    taskId: fixture.task.taskId,
    questionId,
    replyId: 'reply-one',
    reply: 'Yes, within the assigned scope.',
  });

  const forged = await fixture.hook('UserPromptSubmit', {
    prompt: `TAU_REPLY ${questionId} reply-two\nYes, within the assigned scope.`,
    permission_mode: 'bypassPermissions',
  });
  expect(forged.code).toBe(2);
  expect(forged.stderr).toContain('does not match an accepted parent reply');

  const delivered = await fixture.hook('UserPromptSubmit', {
    prompt: `TAU_REPLY ${questionId} reply-one\nYes, within the assigned scope.`,
    permission_mode: 'bypassPermissions',
  });
  expect(delivered.code).toBe(0);
  expect(readPendingQuestion(fixture.directory, fixture.task.taskId)).toBeUndefined();
});

it('denies native delegation, questionnaires, and work after a durable handover', async () => {
  const fixture = await setup();
  await fixture.dispatched();

  const delegation = await fixture.hook('PreToolUse', { tool_name: 'Agent', tool_input: {} });
  expect(delegation.stdout).toContain('"permissionDecision":"deny"');
  expect(delegation.stdout).toContain(claudeToolName('subagent'));

  const questionnaire = await fixture.hook('PreToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: {},
  });
  expect(questionnaire.stdout).toContain('"permissionDecision":"deny"');

  const editing = await fixture.hook('PreToolUse', { tool_name: 'Edit', tool_input: {} });
  expect(editing.stdout).toBe('');
  expect(editing.code).toBe(0);

  await fixture.call('subagent_report', {
    outcome: 'success',
    summary: 'Done.',
    evidence: [],
  });

  const afterReport = await fixture.hook('PreToolUse', { tool_name: 'Edit', tool_input: {} });
  expect(afterReport.stdout).toContain('durable handover');
});

it('refuses a settings source that appears after the loadout resolved', async () => {
  const sources = mkdtempSync(join(tmpdir(), 'tau-settings-'));
  const local = join(sources, 'settings.local.json');
  const fixture = await setup({ integrations: [local] });
  afterTest(() => {
    rmSync(sources, { recursive: true, force: true });
  });

  writeFileSync(local, JSON.stringify({ enabledPlugins: { 'cc-safety-net@fixture': false } }));
  const started = await fixture.started();

  expect(started.stderr).toContain('integration source changed');
  expect(readEvent(fixture.directory, fixture.task.taskId, 'ready')).toBeUndefined();
});

it('refuses hook events from a process that is not the recorded worker', async () => {
  const fixture = await setup();
  await fixture.dispatched();
  const impostor = process.pid + 1;

  const settling = await fixture.hook('Stop', { stop_hook_active: false }, impostor);
  expect(settling.stderr).toContain('another worker process');
  expect(readEvent(fixture.directory, fixture.task.taskId, 'settled')).toBeUndefined();

  const restarting = await fixture.hook(
    'SessionStart',
    {
      transcript_path: fixture.task.nativeSessionFile,
      cwd: fixture.task.loadout.cwd,
      source: 'startup',
    },
    impostor,
  );
  expect(restarting.stderr).toContain('another worker process');
  expect(readEvent(fixture.directory, fixture.task.taskId, 'continuationRefused')).toBeUndefined();

  const acting = await fixture.hook('PreToolUse', { tool_name: 'Edit', tool_input: {} }, impostor);
  expect(acting.stdout).toContain('another worker process');

  const prompting = await fixture.hook(
    'UserPromptSubmit',
    { prompt: 'Work on something else.', permission_mode: 'bypassPermissions' },
    impostor,
  );
  expect(prompting.stderr).toContain('another worker process');

  const settled = await fixture.hook('Stop', { stop_hook_active: false });
  expect(settled.code).toBe(0);
  expect(readEvent(fixture.directory, fixture.task.taskId, 'settled')).toBeDefined();
});

it('denies a tool the recorded loadout does not list', async () => {
  const fixture = await setup();
  await fixture.dispatched();

  const fetching = await fixture.hook('PreToolUse', { tool_name: 'WebFetch', tool_input: {} });

  expect(fetching.stdout).toContain('"permissionDecision":"deny"');
  expect(fetching.stdout).toContain("not one of this worker's tools");

  // Background Bash is unusable without the tools that read and stop the shell it starts.
  const reading = await fixture.hook('PreToolUse', { tool_name: 'BashOutput', tool_input: {} });
  expect(reading.stdout).toBe('');
  expect(reading.code).toBe(0);
});

it('keeps a waiting worker from acting and from settling its turn', async () => {
  const fixture = await setup();
  await fixture.dispatched();
  await fixture.call('subagent_question', { question: 'May I continue?' });

  const blocked = await fixture.hook('PreToolUse', { tool_name: 'Bash', tool_input: {} });
  expect(blocked.stdout).toContain('waiting for a parent reply');

  const stop = await fixture.hook('Stop', { stop_hook_active: false });
  expect(stop.code).toBe(0);
  expect(readEvent(fixture.directory, fixture.task.taskId, 'settled')).toBeUndefined();
});

it('checks task state again when channel tools execute', async () => {
  let launches = 0;
  const fixture = await setup({
    delegation: () => [
      {
        name: 'subagent',
        description: 'Delegate a nested task.',
        parameters: { type: 'object' },
        execute: () => {
          launches += 1;

          return Promise.resolve({ launched: true });
        },
      },
    ],
  });
  await fixture.started();

  expect(text(await fixture.call('subagent'))).toContain('no accepted active task');

  publish(fixture.directory, 'dispatch.json', {
    taskId: fixture.task.taskId,
    prompt: 'Do the task.',
  });
  await fixture.hook('UserPromptSubmit', {
    prompt: 'Do the task.',
    permission_mode: 'bypassPermissions',
  });
  await fixture.call('subagent_question', { question: 'May I continue?' });

  expect(text(await fixture.call('subagent'))).toContain('waiting for a parent reply');
  expect(launches).toBe(0);
  expect(
    text(
      await fixture.call('subagent_report', {
        outcome: 'success',
        summary: 'Too early.',
        evidence: [],
      }),
    ),
  ).toContain('waiting for a parent reply');
  expect(readReport(fixture.directory, fixture.task.taskId)).toBeUndefined();
});

it('settles a finished turn and holds settlement while children are active', async () => {
  let active = 1;
  const fixture = await setup({ children: () => ({ active, uncertain: [] }) });
  await fixture.dispatched();

  await fixture.hook('Stop', {});
  expect(readEvent(fixture.directory, fixture.task.taskId, 'settled')).toBeUndefined();

  active = 0;
  await fixture.hook('Stop', {});
  expect(readEvent(fixture.directory, fixture.task.taskId, 'settled')?.detail).toContain(
    'no pending question or active child',
  );
});

it('accepts one durable report and never replaces it', async () => {
  const fixture = await setup();
  await fixture.dispatched();

  const malformed = await fixture.call('subagent_report', {
    outcome: 'perfect',
    summary: 'Invalid outcome.',
    evidence: [],
  });
  expect(text(malformed)).toContain('Invalid, oversized, or wrong-task report');
  expect(readReport(fixture.directory, fixture.task.taskId)).toBeUndefined();

  const accepted = await fixture.call('subagent_report', {
    outcome: 'success',
    summary: 'Fixture finished.',
    evidence: ['checked'],
  });
  expect(text(accepted)).toContain('Fixture finished.');

  const second = await fixture.call('subagent_report', {
    outcome: 'failure',
    summary: 'Replacement attempt.',
    evidence: [],
  });
  expect(text(second)).toContain('durable handover');
  expect(readReport(fixture.directory, fixture.task.taskId)?.summary).toBe('Fixture finished.');
});

it('refuses a report while the worker still has active children', async () => {
  const fixture = await setup({ children: () => ({ active: 1, uncertain: [] }) });
  await fixture.dispatched();

  const refused = await fixture.call('subagent_report', {
    outcome: 'success',
    summary: 'Too early.',
    evidence: [],
  });

  expect(text(refused)).toContain('Active children remain');
  expect(readReport(fixture.directory, fixture.task.taskId)).toBeUndefined();
});

it('offers the task tools and any delegation the controller provides', async () => {
  const fixture = await setup({
    delegation: () => [
      {
        name: 'subagent',
        description: 'Delegate a nested task.',
        parameters: { type: 'object' },
        execute: () => Promise.resolve({ launched: true }),
      },
    ],
  });

  const listed = await fixture.call('tools/list', {});

  // Claude adds the mcp__tau__ prefix for the model; the channel serves the bare names.
  expect(text(listed)).toContain('"name":"subagent_report"');
  expect(text(listed)).toContain('"name":"subagent_question"');
  expect(text(listed)).toContain('"name":"subagent"');
});

it('fails closed when the parent channel is gone', async () => {
  const fixture = await setup();
  await fixture.dispatched();
  fixture.channel.close();

  const blocked = await fixture.hook('PreToolUse', { tool_name: 'Bash', tool_input: {} });
  const informational = await fixture.hook('Stop', {});

  expect(blocked.code).toBe(2);
  expect(blocked.stderr).toContain('channel is unavailable');
  expect(informational.code).toBe(0);
});

it('refuses a restart of an accepted task but tolerates Claude compacting its own context', async () => {
  const fixture = await setup();
  await fixture.dispatched();

  const compacted = await fixture.hook('SessionStart', {
    transcript_path: fixture.task.nativeSessionFile,
    cwd: fixture.task.loadout.cwd,
    source: 'compact',
  });
  expect(compacted.code).toBe(0);
  expect(readEvent(fixture.directory, fixture.task.taskId, 'continuationRefused')).toBeUndefined();

  const restarted = await fixture.started();
  expect(restarted.code).toBe(2);
  expect(restarted.stderr).toContain('Restarting it is refused');
  expect(
    readEvent(fixture.directory, fixture.task.taskId, 'continuationRefused')?.detail,
  ).toContain('needs final handover');
});

it('delivers a large decision to the worker without truncating it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-channel-flush-'));
  const socketPath = join(directory, 'channel.sock');
  const reason = 'blocked because the parent said so. '.repeat(10_000);
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.end(`${JSON.stringify({ stdout: reason, exitCode: 0 })}\n`);
    });
  });
  await new Promise<void>((listening) => {
    server.listen(socketPath, listening);
  });
  afterTest(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const answered = await channelHook(socketPath, 'PreToolUse', { tool_name: 'Bash' });

  expect(answered.code).toBe(0);
  expect(answered.stdout).toHaveLength(reason.length);
});

it('names a missing Claude process identity instead of dropping the frame', async () => {
  const fixture = await setup();

  const started = await fixture.hook(
    'SessionStart',
    {
      transcript_path: fixture.task.nativeSessionFile,
      cwd: fixture.task.loadout.cwd,
      source: 'startup',
    },
    Number.NaN,
  );

  expect(started.code).toBe(2);
  expect(readEvent(fixture.directory, fixture.task.taskId, 'ready')).toBeUndefined();
  expect(readEvent(fixture.directory, fixture.task.taskId, 'startupFailure')?.detail).toContain(
    'did not report a running process identity',
  );
});

it('refuses channel tools to a process that is not the recorded worker', async () => {
  const fixture = await setup();
  // Readiness names a different live process, so this connection is not the worker's own.
  await fixture.hook(
    'SessionStart',
    {
      transcript_path: fixture.task.nativeSessionFile,
      cwd: fixture.task.loadout.cwd,
      source: 'startup',
    },
    process.ppid,
  );
  publish(fixture.directory, 'dispatch.json', {
    taskId: fixture.task.taskId,
    prompt: 'Do the fixture task.',
  });
  await fixture.hook('UserPromptSubmit', {
    prompt: 'Do the fixture task.',
    permission_mode: 'bypassPermissions',
  });

  const refused = await fixture.call('subagent_report', {
    outcome: 'success',
    summary: 'Not the worker.',
    evidence: [],
  });

  expect(JSON.stringify(refused)).toContain('belongs to another worker process');
  expect(readReport(fixture.directory, fixture.task.taskId)).toBeUndefined();
});
