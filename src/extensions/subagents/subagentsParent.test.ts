import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  ExtensionContext,
  ExtensionToolContext,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { monotonicNow } from './controller/budget.js';
import { WorkerController } from './controller/controller.js';
import { setup } from './controller/fixtures/controllerFixture.js';
import type { HerdrClient } from './controller/inspect.js';
import { fixtureModel } from './fixtures/controlledProvider.js';
import type { WorkerNotice } from './presentation.js';
import { acceptReport, readTask, recordEvent, workerRecordsDirectory } from './records.js';
import subagentsExtension, { createNoticeDelivery, registerCapacityRefusal } from './subagents.js';
import type { WorkerWidgetRow } from './widget.js';

const controllers = vi.hoisted(() => ({
  notifiers: [] as ((notice: WorkerNotice) => void)[],
  client: undefined as HerdrClient | undefined,
  instances: [] as { close: () => void }[],
}));

vi.mock(import('./controller/controller.js'), async (importOriginal) => {
  const original = await importOriginal();

  class CapturingController extends original.WorkerController {
    constructor(...parameters: ConstructorParameters<typeof original.WorkerController>) {
      super(
        parameters[0],
        controllers.client ?? parameters[1],
        parameters[2],
        parameters[3],
        parameters[4],
      );

      controllers.instances.push(this);
      controllers.notifiers.push(parameters[2] ?? (() => undefined));
    }
  }

  return { ...original, WorkerController: CapturingController };
});

let agentDirectory: string;

beforeEach(() => {
  agentDirectory = temporaryDirectory(onTestFinished, 'tau-parent-');
  controllers.notifiers.length = 0;
  controllers.instances.length = 0;
  controllers.client = undefined;
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.spyOn(WorkerController.prototype, 'resume').mockResolvedValue(undefined);
});

afterEach(() => {
  for (const controller of controllers.instances) {
    controller.close();
  }

  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const stoppedNotice: WorkerNotice = {
  content: {
    taskId: 'task-1',
    state: 'stopped',
    deadline: 1,
    outcome: 'success',
  },
  details: { taskId: 'task-1' },
  question: false,
};

const startExtension = () => {
  const fake = fakeExtensionApi();
  const skillPath = join(agentDirectory, 'SKILL.md');
  writeFileSync(skillPath, 'Fixture skill.');

  vi.spyOn(fake.pi, 'getCommands').mockReturnValue([
    { name: 'skill:tdd', source: 'skill', sourceInfo: { path: skillPath } },
  ] as ReturnType<typeof fake.pi.getCommands>);

  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  return fake;
};

const sessionContext = (overrides: Record<string, unknown> = {}) =>
  ({
    cwd: agentDirectory,
    isProjectTrusted: () => false,
    scopedModels: [],
    hasUI: false,
    ui: { notify: vi.fn<() => void>(), setWidget: vi.fn<() => void>() },
    sessionManager: { getSessionId: () => 'parent' },
    ...overrides,
  }) as unknown as ExtensionContext;

const emit = async (
  fake: ReturnType<typeof fakeExtensionApi>,
  name: string,
  event: unknown,
  context: ExtensionContext,
): Promise<void> => {
  await Promise.all(
    (fake.handlers.get(name) ?? []).map((handler) => handler(event as never, context)),
  );
};

describe('worker notices', () => {
  it('wakes an idle parent session when a worker notice arrives', async () => {
    const fake = startExtension();

    await emit(fake, 'session_start', {}, sessionContext({ isIdle: () => true }));

    controllers.notifiers[0]?.(stoppedNotice);

    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    expect(fake.sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true });
  });

  it('delivers a notice after the session shut down without reading a session context', async () => {
    const fake = startExtension();
    const context = sessionContext({ isIdle: () => true });

    await emit(fake, 'session_start', {}, context);
    await emit(fake, 'session_shutdown', { reason: 'quit' }, context);

    controllers.notifiers[0]?.(stoppedNotice);

    expect(fake.sendMessage.mock.calls.map(([, options]) => options)).toEqual([
      { deliverAs: 'steer', triggerTurn: true },
    ]);
  });

  it('steers a notice into a busy parent whose agent is running', () => {
    const fake = fakeExtensionApi();

    createNoticeDelivery(fake.pi)(
      { isIdle: () => false, signal: new AbortController().signal },
      stoppedNotice,
    );

    expect(fake.sendMessage.mock.calls.map(([, options]) => options)).toEqual([
      { deliverAs: 'steer', triggerTurn: true },
    ]);
  });

  it('queues a notice for the next prompt when Pi is busy and no run started', () => {
    const fake = fakeExtensionApi();

    createNoticeDelivery(fake.pi)({ isIdle: () => false, signal: undefined }, stoppedNotice);

    expect(fake.sendMessage.mock.calls.map(([, options]) => options)).toEqual([
      { deliverAs: 'nextTurn' },
    ]);
  });
});

describe('parent tool_call guard', () => {
  const guard = async (
    fake: ReturnType<typeof fakeExtensionApi>,
    event: unknown,
  ): Promise<ToolCallEventResult | undefined> => {
    const context = sessionContext();

    for (const handler of fake.handlers.get('tool_call') ?? []) {
      const result = (await handler(event as never, context)) as ToolCallEventResult | undefined;

      if (result?.block === true) {
        return result;
      }
    }

    return undefined;
  };

  const withActiveWorker = async () => {
    const fake = startExtension();

    vi.spyOn(WorkerController.prototype, 'widgetRows').mockReturnValue([
      { state: 'running' },
    ] as unknown as WorkerWidgetRow[]);

    vi.spyOn(WorkerController.prototype, 'status').mockReturnValue({} as never);

    await fake.tools
      .get('subagent_status')!
      .execute('status', { taskId: 'task-1' }, undefined, undefined, sessionContext() as never);

    return fake;
  };

  it('blocks a long sleep in bash while a worker is active', async () => {
    const fake = await withActiveWorker();

    expect(await guard(fake, { toolName: 'bash', input: { command: 'sleep 900' } })).toMatchObject({
      block: true,
    });
  });

  it('leaves other tools and bash calls without a command string alone', async () => {
    const fake = await withActiveWorker();

    expect(
      await guard(fake, { toolName: 'read', input: { command: 'sleep 900' } }),
    ).toBeUndefined();

    expect(await guard(fake, { toolName: 'bash', input: {} })).toBeUndefined();
    expect(await guard(fake, { toolName: 'bash', input: { command: 900 } })).toBeUndefined();
  });
});

const savedTask = (details: unknown) => readTask((details as { directory: string }).directory);

describe('follow-up and launch tools', () => {
  const parentContext = (sessionFile: string | undefined) =>
    ({
      cwd: agentDirectory,
      isProjectTrusted: () => true,
      modelRegistry: { find: () => fixtureModel },
      scopedModels: [],
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => 'parent-id',
      },
    }) as unknown as ExtensionToolContext;

  const useHerdr = () => {
    const fixture = setup(onTestFinished);
    controllers.client = fixture.client;

    return fixture;
  };

  const launchSettledWorker = async () => {
    useHerdr();
    const context = parentContext(join(agentDirectory, 'parent.jsonl'));

    const result = await startExtension()
      .tools.get('subagent')!
      .execute('call', launchInput, undefined, undefined, context);

    const launched = savedTask(result.details);
    const { directory } = result.details as { directory: string };

    acceptReport(directory, launched.taskId, {
      taskId: launched.taskId,
      outcome: 'success',
      summary: 'Finished.',
      evidence: ['Checked.'],
    });

    recordEvent(directory, launched.taskId, 'settled', {
      detail: 'Worker settled.',
      stopped: true,
    });

    recordEvent(directory, launched.taskId, 'cleanup', {
      detail: 'Parent confirmed exit.',
      stopped: true,
    });

    return { launched, context };
  };

  const followUpInput = {
    sourceTaskId: 'source',
    task: 'Follow up.',
    acceptance: ['Follow-up is done.'],
    timeoutSeconds: 10,
  };

  const launchInput = {
    profile: 'worker',
    model: `${fixtureModel.provider}/${fixtureModel.id}`,
    acceptance: ['Done.'],
    task: 'Inspect fixture.',
    timeoutSeconds: 10,
  };

  it('saves a follow-up deadline from its timeout in seconds, owned by this parent session', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });

    const { launched, context } = await launchSettledWorker();

    const result = await startExtension()
      .tools.get('subagent_follow_up')!
      .execute(
        'call',
        { ...followUpInput, sourceTaskId: launched.taskId },
        undefined,
        undefined,
        context,
      );

    const followUp = savedTask(result.details);

    expect(followUp.deadline).toBe(1_700_000_000_000 + 10_000);
    expect(followUp.predecessorTaskId).toBe(launched.taskId);
    expect(followUp.parentSession).toBe(context.sessionManager.getSessionFile());
    expect(followUp.parentSessionId).toBe('parent-id');
  });

  it.each([
    {
      reason: 'outside herdr',
      paneId: '',
      sessionFile: '/fixture/parent.jsonl',
    },
    {
      reason: 'without a saved session',
      paneId: 'parent',
      sessionFile: undefined,
    },
    { reason: 'with an empty session file', paneId: 'parent', sessionFile: '' },
  ])('refuses a follow-up $reason', async ({ paneId, sessionFile }) => {
    vi.stubEnv('HERDR_PANE_ID', paneId);

    const { calls } = useHerdr();

    await expect(
      startExtension()
        .tools.get('subagent_follow_up')!
        .execute('call', followUpInput, undefined, undefined, parentContext(sessionFile)),
    ).rejects.toThrow('Follow-up requires');

    expect(calls).toEqual([]);
    expect(existsSync(workerRecordsDirectory())).toBe(false);
  });

  it.each([
    {
      reason: 'outside herdr',
      paneId: '',
      sessionFile: '/fixture/parent.jsonl',
    },
    {
      reason: 'without a saved session',
      paneId: 'parent',
      sessionFile: undefined,
    },
    { reason: 'with an empty session file', paneId: 'parent', sessionFile: '' },
  ])('refuses a launch $reason', async ({ paneId, sessionFile }) => {
    vi.stubEnv('HERDR_PANE_ID', paneId);

    const { calls } = useHerdr();

    await expect(
      startExtension()
        .tools.get('subagent')!
        .execute('call', launchInput, undefined, undefined, parentContext(sessionFile)),
    ).rejects.toThrow('Worker launch requires');

    expect(calls).toEqual([]);
    expect(existsSync(workerRecordsDirectory())).toBe(false);
  });

  it('starts the work deadline when the launch tool call begins, not after validation', async () => {
    useHerdr();
    vi.useFakeTimers({ now: 1_700_000_000_000 });

    const begun = Date.now();
    const monotonicBegun = performance.now();
    const entry = monotonicNow();
    let advanced = false;

    const slowValidation = {
      ...parentContext(join(agentDirectory, 'parent.jsonl')),
      isProjectTrusted: () => {
        if (!advanced) {
          advanced = true;
          vi.advanceTimersByTime(5000);
        }

        return true;
      },
      modelRegistry: {
        find: () => {
          vi.advanceTimersByTime(5000);

          return fixtureModel;
        },
      },
    } as unknown as ExtensionToolContext;

    const result = await startExtension()
      .tools.get('subagent')!
      .execute(
        'call',
        { ...launchInput, timeoutSeconds: 600 },
        undefined,
        undefined,
        slowValidation,
      );

    expect(performance.now()).toBeGreaterThan(monotonicBegun + 5000);

    const saved = savedTask(result.details);

    expect(saved.deadline).toBe(begun + 600_000);
    expect(saved.monotonicDeadline).toBe(entry + 600_000);
    expect(saved.parentSession).toBe(join(agentDirectory, 'parent.jsonl'));
  });
});

describe('worker tools', () => {
  it('keeps the launch, follow-up, reply, and cancel tools to the model', () => {
    const { tools } = startExtension();

    for (const name of ['subagent', 'subagent_follow_up', 'subagent_reply', 'subagent_cancel']) {
      expect(tools.get(name)?.exposure).toBe('model-only');
    }
  });

  it('returns a question receipt only when the status call names a question', async () => {
    vi.spyOn(WorkerController.prototype, 'status').mockReturnValue({
      taskId: 'task-1',
    } as ReturnType<WorkerController['status']>);

    vi.spyOn(WorkerController.prototype, 'questionReceipt').mockImplementation(
      (_taskId, _sessionId, questionId) =>
        ({ question: { questionId } }) as ReturnType<WorkerController['questionReceipt']>,
    );

    const tool = startExtension().tools.get('subagent_status')!;
    const context = sessionContext() as unknown as ExtensionToolContext;

    const receiptFor = async (parameters: Record<string, unknown>) =>
      (
        (await tool.execute('call', parameters, undefined, undefined, context)).details as {
          taskId: string;
          questionReceipt?: unknown;
        }
      ).questionReceipt;

    expect(await receiptFor({ taskId: 'task-1' })).toBeUndefined();
    expect(await receiptFor({ taskId: 'task-1', questionId: '' })).toBeUndefined();

    expect(await receiptFor({ taskId: 'task-1', questionId: 'q-1' })).toEqual({
      question: { questionId: 'q-1' },
    });
  });
});

describe('capacity refusal', () => {
  it('lets tools run again when a new session starts', async () => {
    const fake = fakeExtensionApi();
    const capacityRefusal = registerCapacityRefusal(fake.pi);
    const context = sessionContext();

    const blocked = async () => {
      const [handler] = fake.handlers.get('tool_call') ?? [];

      return handler?.({ toolName: 'bash', input: {} } as never, context);
    };

    expect(await blocked()).toBeUndefined();

    capacityRefusal.refuse();

    expect(await blocked()).toMatchObject({ block: true });

    await emit(fake, 'session_start', {}, context);

    expect(await blocked()).toBeUndefined();
  });
});

const useRows = (initial: WorkerWidgetRow[]) => {
  const state = { rows: initial };

  vi.spyOn(WorkerController.prototype, 'widgetRows').mockImplementation(() => state.rows);

  return state;
};

describe('parent widget', () => {
  const runningRow = {
    name: 'scout-ab',
    taskId: 'task-a',
    state: 'running',
    createdAt: 1,
  } as WorkerWidgetRow;

  const tuiContext = () => {
    const setWidget = vi.fn<(key: string, content: unknown, options?: unknown) => void>();

    return {
      setWidget,
      context: sessionContext({
        hasUI: true,
        mode: 'tui',
        ui: { notify: vi.fn<() => void>(), setWidget },
      }),
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('installs the widget on session start and refreshes it on a timer while workers run', async () => {
    useRows([runningRow]);

    const fake = startExtension();
    const { context, setWidget } = tuiContext();

    await emit(fake, 'session_start', {}, context);

    expect(setWidget.mock.calls[0]?.[0]).toBe('tau-subagents');
    expect(vi.getTimerCount()).toBe(1);

    setWidget.mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(setWidget).toHaveBeenCalled();
  });

  it('removes the widget and stops the timer once no worker needs tracking', async () => {
    const state = useRows([runningRow]);
    const fake = startExtension();
    const { context, setWidget } = tuiContext();

    await emit(fake, 'session_start', {}, context);

    state.rows = [];
    await vi.advanceTimersByTimeAsync(2000);

    expect(setWidget).toHaveBeenLastCalledWith('tau-subagents', undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the widget after reattaching workers and after a tool result', async () => {
    const state = useRows([]);
    const fake = startExtension();
    const { context, setWidget } = tuiContext();

    vi.mocked(WorkerController.prototype.resume).mockImplementation(async () => {
      await Promise.resolve();
      state.rows = [runningRow];
    });

    await emit(fake, 'session_start', {}, context);
    await vi.advanceTimersByTimeAsync(0);

    expect(setWidget).toHaveBeenLastCalledWith('tau-subagents', expect.any(Function), {
      placement: 'aboveEditor',
    });

    setWidget.mockClear();
    await emit(fake, 'tool_result', {}, context);

    expect(setWidget).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the newest session context after a second session start', async () => {
    useRows([runningRow]);

    const fake = startExtension();
    const first = tuiContext();
    const second = tuiContext();

    await emit(fake, 'session_start', {}, first.context);
    await emit(fake, 'session_start', {}, second.context);

    first.setWidget.mockClear();
    second.setWidget.mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(first.setWidget).not.toHaveBeenCalled();
    expect(second.setWidget).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('draws nothing outside a terminal UI', async () => {
    useRows([runningRow]);

    const fake = startExtension();
    const noUi = tuiContext();
    const rpc = tuiContext();

    await emit(
      fake,
      'session_start',
      {},
      sessionContext({ hasUI: false, mode: 'tui', ui: noUi.context.ui }),
    );

    await emit(
      fake,
      'tool_result',
      {},
      sessionContext({ hasUI: true, mode: 'rpc', ui: rpc.context.ui }),
    );

    expect(noUi.setWidget).not.toHaveBeenCalled();
    expect(rpc.setWidget).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops drawing and clears the timer when the session shuts down', async () => {
    useRows([runningRow]);

    const fake = startExtension();
    const { context, setWidget } = tuiContext();

    await emit(fake, 'session_start', {}, context);
    await emit(fake, 'session_shutdown', { reason: 'quit' }, context);

    expect(vi.getTimerCount()).toBe(0);

    setWidget.mockClear();
    await emit(fake, 'tool_result', {}, context);

    expect(setWidget).not.toHaveBeenCalled();
  });
});

describe('worker record retention', () => {
  it('deletes an expired stopped worker after session start', async () => {
    const directory = join(workerRecordsDirectory(), 'expired-task');
    const old = new Date(Date.now() - 15 * 86_400_000);

    const cleanup = {
      taskId: 'expired-task',
      kind: 'cleanup',
      detail: 'Stopped.',
      stopped: true,
      at: 1000,
    };

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'cleanup.json'), JSON.stringify(cleanup));
    utimesSync(join(directory, 'cleanup.json'), old, old);
    utimesSync(directory, old, old);

    const fake = startExtension();

    await emit(fake, 'session_start', {}, sessionContext());

    await vi.waitFor(() => {
      expect(existsSync(directory)).toBe(false);
    });
  });

  it('warns when expired worker records cannot be deleted', async () => {
    const root = workerRecordsDirectory();
    const context = sessionContext();

    mkdirSync(dirname(root), { recursive: true });
    writeFileSync(root, '');

    const fake = startExtension();

    await emit(fake, 'session_start', {}, context);

    await vi.waitFor(() => {
      expect(context.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Expired worker records could not be deleted'),
        'warning',
      );
    });
  });
});
