import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import * as cancellation from '../cancellation.js';
import { herdrFake } from '../fixtures/herdrFake.js';
import { fixtureGenericLoadout } from '../fixtures/loadout.js';
import { assignmentContract, handoffContract } from '../handoff.js';
import { searchHistory } from '../history.js';
import { handoffSections } from '../presentation.js';
import type { WorkerNotice } from '../presentation.js';
import { readEvent, readReport, readTask } from '../records.js';
import * as records from '../records.js';
import { WorkerController } from './controller.js';
import type { HerdrClient } from './inspect.js';

const fixture = (kind = 'codex', intercept?: HerdrClient, capacity = 4) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-generic-controller-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('TAU_SUBAGENT_CAP', String(capacity));
  const root = join(directory, 'records');
  const parentSession = join(directory, 'parent.jsonl');
  writeFileSync(
    parentSession,
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent', cwd: directory })}\n`,
  );
  const { client: fakeClient, state: herdrState, calls, layout } = herdrFake(kind);
  const budgets: number[] = [];
  const state = Object.assign(herdrState, {
    shellExitsOnStart: false,
    processStart: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim(),
    shellStart: execFileSync('ps', ['-p', String(process.ppid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim(),
  });
  const client: HerdrClient = async (argumentsList, budget, signal) => {
    budgets.push(budget);

    if (intercept) {
      const response = await intercept(argumentsList, budget, signal);

      if (response) {
        return response;
      }
    }

    // herdr reports no foreground group while the replacement shell starts.
    if (state.shellExitsOnStart && state.started && argumentsList[1] === 'process-info') {
      return JSON.stringify({
        result: { process_info: { pane_id: argumentsList[3], shell_pid: state.shell + 1 } },
      });
    }

    return fakeClient(argumentsList, budget, signal);
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.spyOn(cancellation, 'runClient').mockImplementation(async (_executable, argumentsList) =>
    argumentsList[1] === String(state.shell) ? state.shellStart : state.processStart,
  );
  vi.spyOn(process, 'kill').mockImplementation((processId) => {
    if (processId === state.process && state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }

    return true;
  });
  const notices: WorkerNotice[] = [];
  const finished = Promise.withResolvers<undefined>();
  const controller = new WorkerController(root, client, (notice) => {
    notices.push(notice);

    if (!notice.question && notice.content.cleanup !== undefined) {
      finished.resolve(undefined);
    }
  });
  const loadout = fixtureGenericLoadout(directory, kind);
  const input = {
    task: 'Inspect the fixture.',
    loadout,
    timeout: 10_000,
    parentSession,
    parentSessionId: 'parent',
    parentPane: 'parent',
  };
  const report = (taskId: string, body = 'Completed fixture evidence.', outcome = 'success') => {
    const reportDirectory = join(directory, '.tau', 'workers', taskId);
    const temporary = join(reportDirectory, 'report.partial');
    writeFileSync(
      temporary,
      `Task: ${taskId}\nOutcome: ${outcome}\n\n${body}\n\nEnd task: ${taskId}\n`,
      { flag: 'wx' },
    );
    linkSync(temporary, join(reportDirectory, 'report.md'));
  };
  onTestFinished(() => {
    controller.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directory,
    root,
    controller,
    state,
    calls,
    budgets,
    notices,
    input,
    layout,
    report,
    finished: finished.promise,
  };
};

it.each(['start', 'get'])(
  'recovers generic ownership during shutdown with a pending %s response',
  async (pendingAction) => {
    const entered = Promise.withResolvers<undefined>();
    const released = Promise.withResolvers<undefined>();
    let pause = true;
    const setup = fixture('codex', async (argumentsList) => {
      if (pause && argumentsList[1] === pendingAction) {
        pause = false;
        entered.resolve(undefined);
        await released.promise;
      }

      return '';
    });
    onTestFinished(() => {
      released.resolve(undefined);
    });
    vi.mocked(cancellation.runClient).mockImplementation(
      async (_executable, argumentsList, _budget, options) => {
        options?.signal?.throwIfAborted();

        return argumentsList[1] === String(setup.state.shell)
          ? setup.state.shellStart
          : setup.state.processStart;
      },
    );
    const launching = setup.controller.launch(setup.input);
    await vi.advanceTimersByTimeAsync(100);
    await entered.promise;
    const shutdown = setup.controller.stopAll('reload');
    released.resolve(undefined);
    await shutdown;
    const launched = await launching;

    expect(setup.state.stopped).toBe(true);
    expect(setup.controller.status(launched.taskId, 'parent')).toMatchObject({
      state: 'stopped',
      capacityHeld: false,
    });
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
    expect(setup.calls.filter((call) => call[1] === 'prompt')).toEqual([]);
    expect(setup.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent']);
  },
);

it('retains a pending generic worker when shutdown cannot verify its identity', async () => {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const setup = fixture('codex', async (argumentsList) => {
    if (argumentsList[1] === 'start') {
      entered.resolve(undefined);
      await released.promise;
    }

    return '';
  });
  onTestFinished(() => {
    released.resolve(undefined);
  });
  const launching = setup.controller.launch(setup.input);
  await vi.advanceTimersByTimeAsync(100);
  await entered.promise;
  const shutdown = setup.controller.stopAll('reload');
  setup.state.kind = 'gemini';
  released.resolve(undefined);
  await shutdown;
  const launched = await launching;

  expect(setup.controller.status(launched.taskId, 'parent')).toMatchObject({
    state: 'cleanupUnconfirmed',
    capacityHeld: true,
  });
  expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.detail).toContain(
    'identity changed',
  );
  expect(setup.state.started).toBe(true);
  expect(setup.state.stopped).toBe(false);
  expect(setup.calls.some((call) => ['send-keys', 'close', 'prompt'].includes(call[1] ?? ''))).toBe(
    false,
  );
  expect(setup.layout.panes.map((pane) => pane.pane_id)).toEqual(['parent', 'worker-1']);
});

it('waits for the split shell before starting a native worker', async () => {
  const setup = fixture();
  setup.state.busyShellPolls = 2;

  const launching = setup.controller.launch(setup.input);
  await vi.advanceTimersByTimeAsync(600);
  const launched = await launching;

  expect(launched.state).toBe('running');
  expect(setup.state.started).toBe(true);
  expect(setup.state.busyShellPolls).toBe(0);
});

it.each(['claude', 'codex', 'gemini'])(
  'launches %s through herdr and accepts a complete report without Pi events',
  async (kind) => {
    const setup = fixture(kind);

    const started = await setup.controller.launch(setup.input);

    expect(started.state).toBe('running');
    expect(setup.calls.find((call) => call[1] === 'start')).toEqual([
      'agent',
      'start',
      expect.any(String),
      '--kind',
      kind,
      '--pane',
      'worker-1',
      '--timeout',
      expect.any(String),
      '--',
    ]);
    expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
    expect(setup.calls.filter((call) => call[1] === 'read')).toHaveLength(0);
    const taskDirectory = join(setup.root, started.taskId);
    const task = readTask(taskDirectory);
    expect(task).not.toHaveProperty('nativeSessionId');
    expect(task).not.toHaveProperty('nativeSessionFile');
    expect(readEvent(taskDirectory, task.taskId, 'accepted')).toBeUndefined();
    expect(readEvent(taskDirectory, task.taskId, 'settled')).toBeUndefined();

    setup.report(task.taskId);
    await vi.advanceTimersByTimeAsync(1500);
    await setup.finished;

    expect(readReport(taskDirectory, task.taskId)?.summary).toContain(
      'Completed fixture evidence.',
    );
    expect(setup.controller.status(task.taskId, 'parent')).toMatchObject({
      outcome: 'success',
      state: 'stopped',
      capacityHeld: false,
    });
    expect(setup.calls).toContainEqual(['agent', 'send-keys', 'worker-1', 'ctrl+c']);
    expect(setup.calls).toContainEqual(['pane', 'close', 'worker-1']);
  },
);

it('saves the handoff sections and work reference from a generic Markdown report', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  const taskDirectory = join(setup.root, started.taskId);
  const body = [
    'Changes: edited src/value.ts against baseline 3ee3d7a; untracked notes.md',
    'Evidence: pnpm check passed (1019 tests); record at /saved/run.json',
    'Decisions: none',
    'Concerns: none',
  ].join('\n');

  setup.report(started.taskId, body);
  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;

  const saved = readReport(taskDirectory, started.taskId);
  const reportPath = join(setup.directory, '.tau', 'workers', started.taskId, 'report.md');
  expect(saved?.summary).toContain('baseline 3ee3d7a');
  expect(saved?.summary).toContain('untracked notes.md');
  expect(saved?.evidence).toEqual([reportPath]);
  expect(handoffSections(saved)).toEqual({
    present: ['Changes', 'Evidence', 'Decisions', 'Concerns'],
    missing: [],
  });
});

it('marks a generic report with no Evidence section as missing Evidence', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  const body = ['Changes: edited value.ts', 'Decisions: none', 'Concerns: none'].join('\n');

  setup.report(started.taskId, body);
  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;

  const saved = readReport(join(setup.root, started.taskId), started.taskId);
  expect(handoffSections(saved)).toEqual({
    present: ['Changes', 'Decisions', 'Concerns'],
    missing: ['Evidence'],
  });
});

it('keeps a scripted failed-then-corrected check inside the handoff without waking the parent', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);

  // Scripted fixture plumbing: no agent loop runs; this body stands in for worker activity.
  expect(setup.notices).toHaveLength(0);

  const body = [
    'Changes: saved diff at /saved/check.diff against baseline 3ee3d7a; untracked notes.md',
    'Evidence: focused test failed (1 failed); fixed src/value.ts; pnpm check passed (1027 tests); output /saved/run.json',
    'Decisions: kept the existing loader path',
    'Concerns: none',
  ].join('\n');

  setup.report(started.taskId, body);
  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;

  expect(setup.notices).toHaveLength(1);
  expect(setup.notices[0]?.question).toBe(false);

  const taskDirectory = join(setup.root, started.taskId);
  const saved = readReport(taskDirectory, started.taskId);
  expect(saved?.summary).toContain('focused test failed (1 failed)');
  expect(saved?.summary).toContain('fixed src/value.ts');
  expect(saved?.summary).toContain('pnpm check passed (1027 tests)');
  expect(saved?.summary).toContain('Decisions: kept the existing loader path');

  const status = setup.controller.status(started.taskId, 'parent');
  expect(status.report?.summary).toContain('focused test failed (1 failed)');
  expect(status.state).toBe('stopped');
});

it('sends the autonomous assignment and handoff contract to a generic worker', async () => {
  const setup = fixture();
  await setup.controller.launch(setup.input);
  const promptCall = setup.calls.find((call) => call[1] === 'prompt');
  const prompt = promptCall?.[3];

  expect(typeof prompt).toBe('string');
  expect(prompt).toContain(assignmentContract);
  expect(prompt).toContain(handoffContract);
});

it('keeps the editing assignment out of a generic investigator prompt', async () => {
  const setup = fixture();
  setup.input.loadout = {
    ...setup.input.loadout,
    profile: 'investigator',
    role: 'investigation',
  };
  await setup.controller.launch(setup.input);
  const promptCall = setup.calls.find((call) => call[1] === 'prompt');
  const prompt = promptCall?.[3];

  expect(typeof prompt).toBe('string');
  expect(prompt).toContain(handoffContract);
  expect(prompt).not.toContain(assignmentContract);
});

it('caps each herdr call while polling a long-running generic worker', async () => {
  const setup = fixture();
  await setup.controller.launch({ ...setup.input, timeout: 120_000 });
  setup.budgets.length = 0;

  await vi.advanceTimersByTimeAsync(1500);

  expect(setup.budgets.length).toBeGreaterThan(0);
  expect(Math.max(...setup.budgets)).toBeLessThanOrEqual(30_000);
});

it('reports a startup inspection failure instead of an undetected agent', async () => {
  const setup = fixture();
  setup.state.inspectionError = 'herdr socket closed';

  const started = await setup.controller.launch(setup.input);
  await vi.advanceTimersByTimeAsync(30_000);
  const failure = JSON.stringify(setup.controller.status(started.taskId, 'parent'));

  expect(failure).toContain('herdr socket closed');
  expect(failure).not.toContain('not been detected');
});

it('retains ownership through transient inspection and partial reports without unsafe input', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  const reportPath = join(setup.directory, '.tau', 'workers', started.taskId, 'report.md');
  writeFileSync(reportPath, `Task: ${started.taskId}\nOutcome: success\n\nPartial evidence.`);
  setup.state.inspectionError = 'Temporary herdr inspection failure';

  await vi.advanceTimersByTimeAsync(3000);

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    state: 'running',
    capacityHeld: true,
    nativeState: 'unknown',
  });
  expect(setup.calls.filter((call) => call[1] === 'send-keys')).toHaveLength(0);
  expect(readReport(join(setup.root, started.taskId), started.taskId)).toBeUndefined();
  setup.state.inspectionError = '';
  writeFileSync(
    reportPath,
    `Task: ${started.taskId}\nOutcome: success\n\nComplete evidence.\n\nEnd task: ${started.taskId}\n`,
  );
  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    outcome: 'success',
    state: 'stopped',
    deadline: started.deadline,
  });
});

it('notifies once per unresolved observation-error episode and again after recovery', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  setup.notices.length = 0;

  setup.state.inspectionError = 'First inspection failure.';
  await vi.advanceTimersByTimeAsync(1500);
  expect(setup.notices).toHaveLength(1);
  expect(setup.notices[0]?.content).toMatchObject({ nativeState: 'unknown' });
  expect(String(setup.notices[0]?.content.observationIssue)).toContain('First inspection failure.');

  setup.state.inspectionError = 'Second inspection failure.';
  await vi.advanceTimersByTimeAsync(1500);
  expect(setup.notices).toHaveLength(1);
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    observationIssue: 'Error: Second inspection failure.',
  });

  setup.state.inspectionError = '';
  await vi.advanceTimersByTimeAsync(1500);

  setup.state.inspectionError = 'Third inspection failure.';
  await vi.advanceTimersByTimeAsync(1500);
  expect(setup.notices).toHaveLength(2);
  expect(String(setup.notices[1]?.content.observationIssue)).toContain('Third inspection failure.');
});

it('cancels an identity-checked generic worker before a native reference is available', async () => {
  const setup = fixture();
  setup.state.session = '';
  const started = await setup.controller.launch(setup.input);

  const status = await setup.controller.cancel(started.taskId, 'parent');

  expect(status).toMatchObject({ outcome: 'cancelled', state: 'stopped', capacityHeld: false });
  expect(setup.calls).toContainEqual(['agent', 'send-keys', 'worker-1', 'ctrl+c']);
  expect(setup.calls).toContainEqual(['pane', 'close', 'worker-1']);
});

it('persists a late native reference and refuses input after that reference changes', async () => {
  const setup = fixture();
  setup.state.session = '';
  const started = await setup.controller.launch(setup.input);
  setup.state.session = 'late-reference';

  await vi.advanceTimersByTimeAsync(1500);

  const receipt: unknown = JSON.parse(
    readFileSync(join(setup.root, started.taskId, 'nativeReference.json'), 'utf8'),
  );
  expect(receipt).toEqual({
    taskId: started.taskId,
    reference: { kind: 'id', value: 'late-reference' },
  });
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    nativeReference: { kind: 'id', value: 'late-reference' },
  });
  setup.state.session = 'different-reference';
  await vi.advanceTimersByTimeAsync(1500);
  await expect(
    setup.controller.reply(started.taskId, 'parent', {
      replyId: 'reply',
      reply: 'Keep the scope.',
      scopeUnchanged: true,
    }),
  ).rejects.toThrow('reference changed');
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
  expect(setup.calls.filter((call) => call[1] === 'send-keys')).toHaveLength(0);
  const recovered = new WorkerController(setup.root, async () => {
    throw new Error('Recovery cannot send input.');
  });
  const recoveredStatus = recovered.status(started.taskId, 'parent');
  expect(recoveredStatus).toMatchObject({
    nativeReference: { kind: 'id', value: 'late-reference' },
    state: 'notOwned',
  });
  expect(recoveredStatus.recovery).toMatchObject({
    nativeReference: { kind: 'id', value: 'late-reference' },
  });
  expect(recoveredStatus.recovery).not.toHaveProperty('nativeSessionFile');
});

it('finds saved native references and reports after pane cleanup without inventing sessions', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  setup.report(started.taskId);
  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;

  const history = await searchHistory(
    setup.root,
    { file: setup.input.parentSession, id: 'parent', sessionDirectory: setup.directory },
    'opaque-reference',
  );

  expect(history.outcome).toBe('match');
  expect(history.candidates).toHaveLength(1);
  expect(history.candidates[0]).toMatchObject({
    taskId: started.taskId,
    nativeEvidence: 'opaque',
    nativeReference: { kind: 'id', value: 'opaque-reference' },
    report: { outcome: 'success' },
  });
  expect(history.candidates[0]).not.toHaveProperty('nativeSessionId');
  expect(history.candidates[0]).not.toHaveProperty('nativeSessionFile');
});

it('keeps blocked startup visible and inside the original deadline without submitting an approval', async () => {
  const setup = fixture();
  setup.state.status = 'blocked';
  setup.state.startError = 'agent_not_ready';

  const started = await setup.controller.launch(setup.input);

  expect(started).toMatchObject({ state: 'starting', capacityHeld: true });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
  expect(JSON.stringify(setup.notices)).toContain('blocked');
  setup.state.status = 'idle';
  await vi.advanceTimersByTimeAsync(1500);
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
  expect(setup.controller.status(started.taskId, 'parent').deadline).toBe(started.deadline);
});

it('passes approved native arguments literally and keeps native submission separate from Pi acceptance', async () => {
  const setup = fixture();
  setup.input.loadout.arguments = ['--model', 'model with spaces; $HOME'];
  setup.input.loadout.requestedModel = 'model with spaces; $HOME';
  const started = await setup.controller.launch(setup.input);
  const answer = {
    replyId: 'reply-one',
    reply: 'Stay within the assigned scope.',
    scopeUnchanged: true,
  };

  const receipt = await setup.controller.reply(started.taskId, 'parent', answer);
  const repeated = await setup.controller.reply(started.taskId, 'parent', answer);

  expect(setup.calls.find((call) => call[1] === 'start')?.slice(-3)).toEqual([
    '--',
    '--model',
    'model with spaces; $HOME',
  ]);
  expect(receipt).toMatchObject({ replyAccepted: true, delivery: 'sent' });
  expect(repeated).toEqual({ replyAccepted: true, name: started.name, delivery: 'notResent' });
  expect(
    setup.controller.submissionReceipt(started.taskId, 'parent', answer.replyId),
  ).toMatchObject({ observation: { state: 'submitted' } });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(2);
  await expect(
    setup.controller.reply(started.taskId, 'parent', { ...answer, reply: 'Changed answer text.' }),
  ).rejects.toThrow('Conflicting native submission identity');
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(2);
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    state: 'running',
    requestedModel: setup.input.loadout.requestedModel,
    observedModel: null,
  });
  await expect(
    setup.controller.reply(started.taskId, 'parent', {
      ...answer,
      replyId: 'scope-change',
      scopeUnchanged: false,
    }),
  ).rejects.toThrow('increase scope');
  await expect(setup.controller.reply(started.taskId, 'another-parent', answer)).rejects.toThrow(
    'another parent session',
  );
});

it('returns notResent for a repeated generic reply while the worker is blocked', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  const answer = {
    replyId: 'repeat-reply',
    reply: 'Stay within the assigned scope.',
    scopeUnchanged: true,
  };
  const first = await setup.controller.reply(started.taskId, 'parent', answer);
  expect(first).toMatchObject({ delivery: 'sent' });
  setup.state.status = 'blocked';

  const repeated = await setup.controller.reply(started.taskId, 'parent', answer);

  expect(repeated).toEqual({ replyAccepted: true, name: started.name, delivery: 'notResent' });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(2);
});

it('reports a blocked generic reply as notDelivered without claiming acknowledgement', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  setup.state.promptError = 'Prompt refused';
  setup.state.promptBlocked = true;

  const receipt = await setup.controller.reply(started.taskId, 'parent', {
    replyId: 'blocked-reply',
    reply: 'More work.',
    scopeUnchanged: true,
  });

  expect(receipt).toEqual({ replyAccepted: true, name: started.name, delivery: 'notDelivered' });
  expect(receipt).not.toHaveProperty('workerAcknowledged');
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    assignment: { observation: { state: 'submitted' } },
  });
});

it.each([
  { blocked: true, delivery: 'notDelivered' },
  { blocked: false, delivery: 'uncertain' },
])(
  'repeats a $delivery generic reply with its saved outcome without prompting again',
  async ({ blocked, delivery }) => {
    const setup = fixture();
    const started = await setup.controller.launch(setup.input);
    const answer = { replyId: 'failed-reply', reply: 'More work.', scopeUnchanged: true };
    setup.state.promptError = 'Prompt refused';
    setup.state.promptBlocked = blocked;
    await setup.controller.reply(started.taskId, 'parent', answer);
    const prompts = setup.calls.filter((call) => call[1] === 'prompt').length;

    const repeated = await setup.controller.reply(started.taskId, 'parent', answer);

    expect(repeated).toMatchObject({ replyAccepted: true, delivery });
    expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(prompts);
  },
);

it('returns uncertain startup for inspection without waiting out or resetting the deadline', async () => {
  const setup = fixture();
  setup.state.inspectionError = 'Temporary startup observation failure';
  const outcome = await setup.controller.launch(setup.input);

  await vi.advanceTimersByTimeAsync(100);

  expect(outcome).toMatchObject({ state: 'starting', capacityHeld: true });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
  setup.state.inspectionError = '';
  await vi.advanceTimersByTimeAsync(1500);
  expect(setup.calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
});

it('sends leading-dash replies as positional text rather than herdr options', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);

  await setup.controller.reply(started.taskId, 'parent', {
    replyId: 'literal',
    reply: '--help is task text, not an option.',
    scopeUnchanged: true,
  });

  expect(setup.calls.at(-1)).toEqual([
    'agent',
    'prompt',
    'worker-1',
    '--help is task text, not an option.',
  ]);
});

it.each(['unsupported kind', 'missing executable'])(
  'fails a rejected %s start promptly without retry, timeout, or retained capacity',
  async (scenario) => {
    const setup = fixture();
    setup.state.rejectStart = true;
    setup.state.startError =
      scenario === 'unsupported kind'
        ? 'error: invalid value notakind for --kind'
        : 'No such file or directory';

    const started = await setup.controller.launch(setup.input);

    expect(started).toMatchObject({ outcome: 'failure', state: 'stopped', capacityHeld: false });
    expect(started.failure).toContain('rejected');
    expect(readEvent(started.directory, started.taskId, 'cleanup')?.stopped).toBe(true);
    expect(setup.calls.filter((call) => call[1] === 'close')).toEqual([
      ['pane', 'close', 'worker-1'],
    ]);
    expect(setup.calls.filter((call) => call[1] === 'start')).toHaveLength(1);
    expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
    expect(setup.calls.filter((call) => call[1] === 'get')).toHaveLength(1);
  },
);

it('keeps a lost start response uncertain when absence inspection fails', async () => {
  const setup = fixture();
  setup.state.rejectStart = true;
  setup.state.startError = 'Startup response lost';
  setup.state.inspectionError = 'Temporary herdr inspection failure';

  const started = await setup.controller.launch(setup.input);

  expect(started).toMatchObject({ state: 'starting', capacityHeld: true });
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    nativeState: 'unknown',
  });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
});

it('does not claim nondelivery when only the submission receipt write fails', async () => {
  const setup = fixture();
  const publish = records.publish;
  vi.spyOn(records, 'publish').mockImplementation((directory, name, value) => {
    if (name === 'submission-assignment-observation.json') {
      throw new Error('Receipt write failed.');
    }

    publish(directory, name, value);
  });

  const started = await setup.controller.launch(setup.input);
  await vi.advanceTimersByTimeAsync(3000);

  expect(
    setup.controller.submissionReceipt(started.taskId, 'parent', 'assignment')?.observation,
  ).toBeUndefined();
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
  expect(setup.notices.at(-1)?.content).toMatchObject({ nativeState: 'unknown' });
  expect(JSON.stringify(setup.notices)).not.toContain('no input sent');
});

it.each([
  { blocked: true, state: 'not-delivered' },
  { blocked: false, state: 'uncertain' },
])('notifies the parent once when the assignment is $state', async ({ blocked, state }) => {
  const setup = fixture();
  setup.state.promptError = 'Prompt refused or lost';
  setup.state.promptBlocked = blocked;

  await setup.controller.launch(setup.input);
  await vi.advanceTimersByTimeAsync(4500);

  const expectedDelivery = state === 'not-delivered' ? 'notDelivered' : 'uncertain';
  expect(
    setup.notices.filter((notice) => notice.content.delivery === expectedDelivery),
  ).toHaveLength(1);
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
});

it('keeps an uncertain start pending when herdr reports a replaced shell', async () => {
  const setup = fixture();
  setup.state.startError = 'Startup response lost';
  setup.state.shellExitsOnStart = true;

  await setup.controller.launch(setup.input);

  expect(setup.calls).toContainEqual(['agent', 'get', 'worker-1']);
});

it('keeps uncertain startup and text delivery visible without repeating either operation', async () => {
  const setup = fixture();
  setup.state.startError = 'Startup response lost';
  setup.state.promptError = 'Prompt response lost';
  const started = await setup.controller.launch(setup.input);

  await vi.advanceTimersByTimeAsync(4500);

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    state: 'starting',
    assignment: { observation: { state: 'uncertain' } },
    deadline: started.deadline,
  });
  expect(setup.calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
  await expect(
    setup.controller.reply(started.taskId, 'parent', {
      replyId: 'reply',
      reply: 'More work.',
      scopeUnchanged: true,
    }),
  ).rejects.toThrow('delivery is not confirmed');
});

it.each(['blocked', 'unknown'])(
  'reads native %s output only on request and refuses replies without approving dialogs',
  async (status) => {
    const setup = fixture();
    const started = await setup.controller.launch(setup.input);
    setup.state.status = status;

    const output = await setup.controller.nativeOutput(started.taskId, 'parent');

    expect(output.text).toContain('bounded native question');
    expect(setup.calls.filter((call) => call[1] === 'read')).toHaveLength(1);
    await expect(
      setup.controller.reply(started.taskId, 'parent', {
        replyId: 'reply',
        reply: 'yes',
        scopeUnchanged: true,
      }),
    ).rejects.toThrow('blocked, or has unknown state');
    expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
    expect(setup.controller.status(started.taskId, 'parent').deadline).toBe(started.deadline);
  },
);

it('follows the owned terminal after a pane move without touching the old pane', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  const pane = setup.layout.panes[1];

  if (!pane) {
    throw new Error('Fixture worker pane missing.');
  }

  pane.pane_id = 'moved-pane';

  await setup.controller.reply(started.taskId, 'parent', {
    replyId: 'moved-reply',
    reply: 'Same task.',
    scopeUnchanged: true,
  });

  expect(setup.calls.at(-1)).toEqual(['agent', 'prompt', 'moved-pane', 'Same task.']);
});

it.each(['terminal', 'kind', 'process', 'shell'] as const)(
  'refuses input after the native %s identity is replaced',
  async (changed) => {
    const setup = fixture();
    const started = await setup.controller.launch(setup.input);
    const pane = setup.layout.panes[1];

    if (!pane) {
      throw new Error('Fixture worker pane missing.');
    }

    if (changed === 'terminal') {
      pane.terminal_id = 'replacement-terminal';
    } else if (changed === 'kind') {
      setup.state.kind = 'unrelated';
    } else if (changed === 'process') {
      setup.state.processStart = 'replacement-start';
    } else {
      setup.state.shellStart = 'replacement-shell';
    }

    await expect(
      setup.controller.reply(started.taskId, 'parent', {
        replyId: 'reply',
        reply: 'No input.',
        scopeUnchanged: true,
      }),
    ).rejects.toThrow(changed === 'terminal' ? 'is absent' : 'identity changed');

    expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
    expect(setup.calls.filter((call) => call[1] === 'send-keys')).toHaveLength(0);
  },
);

it('marks process exit without a report incomplete and releases capacity only after stopped-shell cleanup', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  setup.state.stopped = true;

  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    outcome: 'incomplete',
    state: 'stopped',
    capacityHeld: false,
  });
});

it.each(['cancelled', 'timeout'] as const)(
  'saves a report published between polls before %s cleanup closes the pane',
  async (reason) => {
    const setup = fixture();
    const started = await setup.controller.launch(setup.input);

    if (reason === 'cancelled') {
      setup.report(started.taskId);
      await setup.controller.cancel(started.taskId, 'parent');
    } else {
      await vi.advanceTimersByTimeAsync(7000);
      setup.report(started.taskId);
      await vi.advanceTimersByTimeAsync(501);
      await setup.finished;
    }

    expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
      outcome: reason,
      state: 'stopped',
    });
    expect(readReport(join(setup.root, started.taskId), started.taskId)?.summary).toContain(
      'Completed fixture evidence.',
    );
  },
);

it('keeps status readable after a report too large to accept', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  setup.report(started.taskId, 'x'.repeat(12_000));

  await vi.advanceTimersByTimeAsync(1500);
  await setup.finished;

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    state: 'stopped',
  });
  expect(readFileSync(join(setup.root, started.taskId, 'nativeFailure.json'), 'utf8')).toContain(
    'at most 10000 bytes',
  );
});

it('keeps an unknown worker inside its original deadline and does not infer success from idle or done', async () => {
  const setup = fixture();
  setup.state.status = 'unknown';
  const started = await setup.controller.launch(setup.input);

  await vi.advanceTimersByTimeAsync(7501);
  await setup.finished;

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    outcome: 'timeout',
    state: 'stopped',
    deadline: started.deadline,
  });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
});

it('retains controller capacity when generic interrupts cannot confirm a stop', async () => {
  const setup = fixture('codex', undefined, 1);
  const started = await setup.controller.launch(setup.input);
  setup.state.ignoreInterrupt = true;
  const cancelling = setup.controller.cancel(started.taskId, 'parent');

  await vi.advanceTimersByTimeAsync(10_001);
  const status = await cancelling;

  expect(status).toMatchObject({
    outcome: 'cancelled',
    state: 'cleanupUnconfirmed',
    capacityHeld: true,
  });
  await expect(setup.controller.launch({ ...setup.input, task: 'Another task.' })).rejects.toThrow(
    'capacity full',
  );
  expect(setup.calls.filter((call) => call[1] === 'start')).toHaveLength(1);
  expect(setup.calls.filter((call) => call[1] === 'close')).toHaveLength(0);
  expect(
    setup.calls
      .filter((call) => call[1] === 'send-keys')
      .every((call) => call[0] === 'agent' && call.slice(3).join(' ') === 'ctrl+c'),
  ).toBe(true);
});

it('bounds native polling without reading terminal text in the background', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  setup.calls.length = 0;
  vi.mocked(cancellation.runClient).mockClear();

  await vi.advanceTimersByTimeAsync(6000);

  expect(setup.calls.filter((call) => call[1] === 'get')).toHaveLength(4);
  expect(setup.calls).toHaveLength(12);
  expect(cancellation.runClient).toHaveBeenCalledTimes(8);
  expect(setup.calls.filter((call) => call[1] === 'read')).toHaveLength(0);
  expect(setup.controller.status(started.taskId, 'parent').state).toBe('running');
});
