import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import * as cancellation from './cancellation.js';
import { WorkerController } from './controller.js';
import type { HerdrClient } from './controller.js';
import { fixtureGenericLoadout } from './fixtures/loadout.js';
import { searchHistory } from './history.js';
import * as identity from './identity.js';
import { placementFixture } from './placementFixture.js';
import { readEvent, readReport, readTask } from './records.js';
import * as records from './records.js';

const fixture = (kind = 'codex') => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-generic-controller-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('TAU_SUBAGENT_CAP', '4');
  const root = join(directory, 'records');
  const parentSession = join(directory, 'parent.jsonl');
  writeFileSync(
    parentSession,
    `${JSON.stringify({ type: 'session', version: 3, id: 'parent', cwd: directory })}\n`,
  );
  const layout = placementFixture(200, 60);
  const state = {
    started: false,
    stopped: false,
    status: 'idle',
    kind,
    startError: '',
    rejectStart: false,
    promptError: '',
    promptBlocked: false,
    inspectionError: '',
    ignoreInterrupt: false,
    session: 'opaque-reference',
    shell: process.ppid,
    process: process.pid,
    processStart: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim(),
    shellStart: execFileSync('ps', ['-p', String(process.ppid), '-o', 'lstart='], {
      encoding: 'utf8',
    }).trim(),
  };
  const calls: string[][] = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.spyOn(identity, 'currentProcessIdentity').mockResolvedValue({
    processId: 300,
    startedAt: 'parent-start',
  });
  vi.spyOn(cancellation, 'runClient').mockImplementation(async (_executable, arguments_) =>
    arguments_[1] === String(state.shell) ? state.shellStart : state.processStart,
  );
  vi.spyOn(process, 'kill').mockImplementation((processId) => {
    if (processId === state.process && state.stopped) {
      throw Object.assign(new Error('Absent'), { code: 'ESRCH' });
    }
    return true;
  });
  const client: HerdrClient = async (arguments_) => {
    calls.push(arguments_);
    const [surface, action] = arguments_;
    if (surface === 'agent' && action === 'list') {
      return JSON.stringify({ result: { type: 'agent_list', agents: [] } });
    }
    const pane = layout.panes[1];
    if (surface === 'agent' && action === 'start') {
      if (state.startError) {
        state.started = !state.rejectStart;
        throw new Error(state.startError);
      }
      state.started = true;
      return JSON.stringify({ result: {} });
    }
    if (action === 'process-info') {
      const processId = state.started && !state.stopped ? state.process : state.shell;
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: pane?.pane_id,
            shell_pid: state.shell,
            foreground_process_group_id: processId,
            foreground_processes: [{ pid: processId, argv: [state.kind] }],
          },
        },
      });
    }
    if (surface === 'agent' && action === 'get') {
      if (state.inspectionError) {
        throw new Error(state.inspectionError);
      }
      if (state.rejectStart) {
        const error = new Error('agent target not found');
        Object.assign(error, {
          stderr: JSON.stringify({ error: { code: 'agent_not_found' } }),
        });
        throw error;
      }
      return JSON.stringify({
        result: {
          agent: {
            pane_id: pane?.pane_id,
            agent: state.kind,
            agent_status: state.status,
            agent_session: state.session ? { kind: 'id', value: state.session } : null,
          },
        },
      });
    }
    if (surface === 'agent' && action === 'read') {
      return JSON.stringify({ result: { text: 'A bounded native question or approval.' } });
    }
    if (surface === 'agent' && action === 'prompt') {
      // Real herdr rejects '--' as text; a separator here would fail delivery.
      if (arguments_[3] === '--') {
        throw new Error('unknown option: text');
      }
      if (state.promptError) {
        throw Object.assign(new Error(state.promptError), {
          stderr: state.promptBlocked ? JSON.stringify({ error: { code: 'agent_blocked' } }) : '',
        });
      }
      return JSON.stringify({ result: {} });
    }
    if (surface === 'agent' && action === 'send-keys') {
      if (!state.ignoreInterrupt) {
        state.stopped = true;
      }
      return JSON.stringify({ result: {} });
    }
    return layout.client(arguments_);
  };
  const notices: string[] = [];
  const finished = Promise.withResolvers<undefined>();
  const controller = new WorkerController(root, client, (message) => {
    notices.push(message);
    if (message.includes('Records:')) {
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
    const reportDirectory = join(directory, `.tau-worker-${taskId}`);
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
    notices,
    input,
    layout,
    report,
    finished: finished.promise,
  };
};

it.each(['claude', 'codex', 'gemini'])(
  'launches %s through herdr and accepts a complete report without Pi events',
  async (kind) => {
    const setup = fixture(kind);

    const started = await setup.controller.launch(setup.input);

    expect(started.outcome).toBe('running');
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
      stopped: true,
      capacityHeld: false,
    });
    expect(setup.calls).toContainEqual(['agent', 'send-keys', 'worker-1', 'ctrl+c']);
    expect(setup.calls).toContainEqual(['pane', 'close', 'worker-1']);
  },
);

it('retains ownership through transient inspection and partial reports without unsafe input', async () => {
  const setup = fixture();
  const started = await setup.controller.launch(setup.input);
  const reportPath = join(setup.directory, `.tau-worker-${started.taskId}`, 'report.md');
  writeFileSync(reportPath, `Task: ${started.taskId}\nOutcome: success\n\nPartial evidence.`);
  setup.state.inspectionError = 'Temporary herdr inspection failure';

  await vi.advanceTimersByTimeAsync(3000);

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    outcome: 'running',
    stopped: false,
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
    stopped: true,
    deadline: started.deadline,
  });
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
  expect(recovered.status(started.taskId, 'parent')).toMatchObject({
    nativeReference: { kind: 'id', value: 'late-reference' },
    ownedByThisParent: false,
  });
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

  expect(started).toMatchObject({ outcome: 'running', capacityHeld: true });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
  expect(setup.notices.join('\n')).toContain('blocked');
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
  expect(receipt).toMatchObject({ observation: { state: 'submitted' } });
  expect(repeated).toEqual(receipt);
  expect(setup.controller.submissionReceipt(started.taskId, 'parent', answer.replyId)).toEqual(
    receipt,
  );
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(2);
  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    accepted: false,
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

it('returns uncertain startup for inspection without waiting out or resetting the deadline', async () => {
  const setup = fixture();
  setup.state.inspectionError = 'Temporary startup observation failure';
  let outcome: unknown;
  const launching = setup.controller.launch(setup.input).then(
    (status) => {
      outcome = status;
    },
    (error: unknown) => {
      outcome = error;
    },
  );

  await vi.advanceTimersByTimeAsync(100);

  expect(outcome).toMatchObject({ outcome: 'running', stopped: false, capacityHeld: true });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
  setup.state.inspectionError = '';
  await vi.advanceTimersByTimeAsync(1500);
  await launching;
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

    expect(started).toMatchObject({ outcome: 'failure', stopped: true, capacityHeld: false });
    expect(started.failure).toContain('rejected');
    expect(started.cleanup).toContain('absence evidence');
    expect(started.cleanup).not.toContain('No worker process was ever started');
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

  expect(started).toMatchObject({ outcome: 'running', stopped: false, capacityHeld: true });
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
  expect(setup.notices.join(' ')).toContain('delivery is uncertain');
  expect(setup.notices.join(' ')).not.toContain('no input sent');
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

  expect(setup.notices.filter((notice) => notice.includes(`assignment ${state}`))).toHaveLength(1);
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(1);
});

it('keeps uncertain startup and text delivery visible without repeating either operation', async () => {
  const setup = fixture();
  setup.state.startError = 'Startup response lost';
  setup.state.promptError = 'Prompt response lost';
  const started = await setup.controller.launch(setup.input);

  await vi.advanceTimersByTimeAsync(4500);

  expect(setup.controller.status(started.taskId, 'parent')).toMatchObject({
    outcome: 'running',
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
    reportAccepted: false,
    stopped: true,
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
      reportAccepted: true,
      stopped: true,
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
    reportAccepted: false,
    stopped: true,
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
    reportAccepted: false,
    stopped: true,
    deadline: started.deadline,
  });
  expect(setup.calls.filter((call) => call[1] === 'prompt')).toHaveLength(0);
});

it('retains shared capacity when generic interrupts cannot confirm a stop', async () => {
  const setup = fixture();
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');
  const started = await setup.controller.launch(setup.input);
  setup.state.ignoreInterrupt = true;
  const cancelling = setup.controller.cancel(started.taskId, 'parent');

  await vi.advanceTimersByTimeAsync(10_001);
  const status = await cancelling;

  expect(status).toMatchObject({ outcome: 'cancelled', stopped: false, capacityHeld: true });
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
  expect(setup.controller.status(started.taskId, 'parent').outcome).toBe('running');
});
