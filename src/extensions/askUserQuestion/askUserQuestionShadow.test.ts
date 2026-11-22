import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ModelRegistry, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { git, initializeRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { shadowCohort } from '../../config/questionGateModels.js';
import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import type { ShadowRecord, ShadowRecordWriter } from '../../questionGate/questionGate.js';
import { ensureTauDirectory, findSharedRepositoryRoot } from '../../tauDirectory.js';
import askUserQuestionExtension from './askUserQuestion.js';
import type { DialogResult } from './dialog.js';
import { createShadowRunner, shadowAnswer } from './shadow.js';

interface OpenDialog {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface RegistryHarness {
  registry: ModelRegistry;
  classify: Mock;
  complete: Mock;
  find: Mock;
  findOfType: Mock;
  judgeGate: Deferred<undefined>;
  judgeBatchDone: Deferred<undefined>;
  classifierSignals: (AbortSignal | undefined)[];
  panelSignals: (AbortSignal | undefined)[];
}

type ClassifyMock = (
  model: unknown,
  context: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

type FindMock = (provider: string, id: string) => { provider: string; id: string } | undefined;

type FindOfTypeMock = (
  type: string,
  provider: string,
  id: string,
) => { provider: string; id: string } | undefined;

interface SavedRecord {
  path: string;
  record: ShadowRecord;
  mode: number | undefined;
}

interface HarnessOptions {
  config?: unknown;
  git?: boolean | undefined;
  registry?: RegistryHarness;
  saveGate?: Deferred<undefined>;
  now?: () => number;
  sessionId?: string;
  rejectWith?: () => Promise<unknown> | undefined;
  openWithoutFactory?: boolean | undefined;
  writeRecord?: ShadowRecordWriter;
  findRootGate?: Deferred<string | undefined>;
  directoryGate?: Deferred<undefined>;
  dialogResult?: Deferred<DialogResult | undefined>;
  projectTrusted?: boolean;
  // Prepares the repository and returns the checkout the tool runs in.
  prepareRepository?: (repository: string) => Promise<string>;
}

const deferred = <T>(): Deferred<T> => {
  const settled = Promise.withResolvers<T>();

  return { promise: settled.promise, resolve: settled.resolve, reject: settled.reject };
};

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5_000 });

const pastAnswer = {
  time: 1,
  question: {
    question: 'Which layout should the dashboard use?',
    problem: 'The dashboard ships next week.',
    impact: 'Changing the layout later moves every panel.',
    options: [
      { label: 'Stacked', description: 'One column.', recommended: true },
      { label: 'Split', description: 'Two columns.', recommended: false },
    ],
  },
  outcome: { kind: 'typed' as const, text: 'Stacked' },
};

const defaultShadow: ShadowConfig = {
  variant: 'classifierExamples',
  cutoff: 0.8,
  examples: [pastAnswer],
};

const frozenConfig = (
  shadow: ShadowConfig = defaultShadow,
): QuestionGateConfig & { shadow: ShadowConfig } => ({
  classifier: 'tau-fixture/classifier',
  panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
  decide: false,
  shadow,
});

const configWithShadow = (shadow: ShadowConfig = defaultShadow) => ({
  questionGate: frozenConfig(shadow),
});

const configWithoutShadow = () => ({
  questionGate: {
    classifier: 'tau-fixture/classifier',
    panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
  },
});

const invalidConfig = () => ({
  questionGate: {
    ...frozenConfig(),
    shadow: { variant: 'classifierExamples', cutoff: 0.8 },
  },
});

const stackedDescription = 'One column. Simple, but wide screens waste space.';
const splitDescription = 'Two columns. Uses wide screens, but needs a fallback.';

const eligibleQuestion = {
  question: 'Which layout should the dashboard use?',
  problem: 'The dashboard ships next week.',
  impact: 'Changing the layout later moves every panel.',
  header: 'Layout',
  kind: 'choice',
  options: [
    {
      label: 'Stacked',
      description: stackedDescription,
      recommended: true,
    },
    {
      label: 'Split',
      description: splitDescription,
    },
  ],
};

const fakeRegistry = (
  options: { missingPanel?: string; missingClassifier?: boolean } = {},
): RegistryHarness => {
  const judgeGate = deferred<undefined>();
  const judgeBatchDone = deferred<undefined>();
  const classifierSignals: (AbortSignal | undefined)[] = [];
  const panelSignals: (AbortSignal | undefined)[] = [];
  let inFlight = 0;

  const beginCall = () => {
    inFlight += 1;
  };

  const endCall = () => {
    inFlight -= 1;

    if (inFlight === 0) {
      setTimeout(() => {
        judgeBatchDone.resolve(undefined);
      }, 0);
    }
  };

  const classify = vi.fn<ClassifyMock>(async (_model, _context, callOptions) => {
    beginCall();
    classifierSignals.push(callOptions?.signal);

    try {
      await judgeGate.promise;

      return {
        stopReason: 'stop',
        answers: {
          choice: { type: 'choice', choice: 'accept', probabilities: {}, confidence: 0.9 },
        },
      };
    } finally {
      endCall();
    }
  });

  const complete = vi.fn<ClassifyMock>(async (_model, _context, callOptions) => {
    beginCall();
    panelSignals.push(callOptions?.signal);

    try {
      await judgeGate.promise;

      return { stopReason: 'stop', content: [{ type: 'text', text: 'Stacked' }] };
    } finally {
      endCall();
    }
  });

  const find = vi.fn<FindMock>((_provider, id) =>
    id === options.missingPanel ? undefined : { provider: 'tau-fixture', id },
  );

  const findOfType = vi.fn<FindOfTypeMock>((_type, provider, id) =>
    options.missingClassifier === true ? undefined : { provider, id },
  );

  return {
    registry: { classify, complete, find, findOfType } as unknown as ModelRegistry,
    classify,
    complete,
    find,
    findOfType,
    judgeGate,
    judgeBatchDone,
    classifierSignals,
    panelSignals,
  };
};

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const createHarness = async (
  onTestFinished: (cleanup: () => void) => void,
  options: HarnessOptions = {},
) => {
  const repository = temporaryDirectory(onTestFinished, 'tau-shadow-question-');

  if (options.git !== false) {
    await initializeRepository(repository);
  }

  const activeDirectory =
    options.prepareRepository === undefined
      ? repository
      : await options.prepareRepository(repository);

  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shadow-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  if (options.config !== undefined) {
    writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(options.config));
  }

  const clock = { now: 0 };
  const scheduled: (() => Promise<void>)[] = [];
  const saved: SavedRecord[] = [];
  const preparedDirectories: string[] = [];
  const findRootStarted = deferred<undefined>();
  let findRootCalls = 0;
  const directoryStarted = deferred<undefined>();
  let writeStarted = 0;
  const saveGate = options.saveGate ?? deferred<undefined>();
  const saveStarted = deferred<undefined>();
  const registry = options.registry ?? fakeRegistry();

  onTestFinished(() => {
    saveGate.resolve(undefined);
    registry.judgeGate.resolve(undefined);
  });

  const writeRecord: ShadowRecordWriter = async (path, record, mode) => {
    writeStarted += 1;
    saveStarted.resolve(undefined);

    await saveGate.promise;

    saved.push({ path, record, mode });
  };

  const fake = fakeExtensionApi();

  askUserQuestionExtension(fake.pi, {
    shadow: {
      now: options.now ?? (() => clock.now),
      schedule: (work) => {
        scheduled.push(work);
      },
      findSharedRoot: async (cwd, signal) => {
        findRootCalls += 1;
        findRootStarted.resolve(undefined);

        if (options.findRootGate !== undefined) {
          const gatedRoot = await options.findRootGate.promise;

          if (gatedRoot !== undefined) {
            return gatedRoot;
          }
        }

        return findSharedRepositoryRoot(cwd, { signal });
      },
      ensureDirectory: async (root, path) => {
        preparedDirectories.push(path);
        directoryStarted.resolve(undefined);

        await options.directoryGate?.promise;

        return ensureTauDirectory(root, path);
      },
      writeRecord: options.writeRecord ?? writeRecord,
    },
  });

  const dialogs: OpenDialog[] = [];

  const terminal = {
    terminal: { rows: 24, columns: 60, setProgramStatus: () => undefined },
    requestRender: () => undefined,
  };

  const custom = (factory: unknown) => {
    const settled = Promise.withResolvers<DialogResult | undefined>();

    if (options.openWithoutFactory === true) {
      settled.resolve(undefined);

      return settled.promise;
    }

    const build = factory as (...args: unknown[]) => OpenDialog;
    const done = options.dialogResult === undefined ? settled.resolve : () => undefined;

    dialogs.push(build(terminal, theme, undefined, done));

    if (options.dialogResult !== undefined) {
      return options.dialogResult.promise;
    }

    if (options.rejectWith !== undefined) {
      const rejection = options.rejectWith();

      if (rejection !== undefined) {
        rejection
          .then((error) => {
            settled.reject(error);
          })
          .catch(() => undefined);
      }
    }

    return settled.promise;
  };

  const context = {
    mode: 'tui',
    cwd: activeDirectory,
    isProjectTrusted: () => options.projectTrusted === true,
    modelRegistry: registry.registry,
    ui: { custom },
    sessionManager: {
      getSessionId: () => options.sessionId ?? 'session-shadow-1',
      getBranch: () => [],
      getSessionName: () => undefined,
    },
  } as unknown as Parameters<ToolDefinition['execute']>[4];

  const tool = fake.tools.get('ask_user_question');

  if (tool === undefined) {
    throw new Error('The extension registered no tool.');
  }

  const run = (questions: unknown[]) => {
    const params: Parameters<ToolDefinition['execute']>[1] = validateToolArguments(tool, {
      type: 'toolCall',
      id: 'call',
      name: tool.name,
      arguments: { questions } as unknown as ToolCall['arguments'],
    });

    return tool.execute('call', params, undefined, undefined, context);
  };

  const latest = (): OpenDialog => {
    const dialog = dialogs.at(-1);

    if (dialog === undefined) {
      throw new Error('No dialog is open.');
    }

    return dialog;
  };

  const start = () => {
    const work = scheduled.shift();

    return work?.();
  };

  const flush = async () => {
    while (scheduled.length > 0) {
      const work = scheduled.shift();

      await work?.();
    }
  };

  return {
    agentDirectory,
    repository,
    cwd: activeDirectory,
    registry,
    clock,
    saved,
    saveGate,
    saveStarted,
    findRootStarted,
    findRootCalls: () => findRootCalls,
    directoryStarted,
    preparedDirectories,
    writeStarted: () => writeStarted,
    dialogs,
    run,
    latest,
    start,
    flush,
    scheduledCount: () => scheduled.length,
  };
};

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[]).map((item) => item.text).join('\n');

const answeredText =
  'User has answered your questions: "Which layout should the dashboard use?"="Stacked". You can now continue with the user\'s answers in mind.';

const answeredDetails = {
  kind: 'answered',
  answers: [
    { question: 'Which layout should the dashboard use?', selected: ['Stacked'], typed: false },
  ],
};

const recordOf = (harness: { saved: SavedRecord[] }): ShadowRecord | undefined =>
  harness.saved[0]?.record;

const judgeModels = [
  'tau-fixture/classifier',
  'tau-fixture/panel-a',
  'tau-fixture/panel-b',
  'tau-fixture/panel-c',
];

const withoutPanelB = judgeModels.filter((model) => model !== 'tau-fixture/panel-b');

const writeAllowedModels = (directory: string, models: string[]) => {
  mkdirSync(join(directory, '.pi'), { recursive: true });
  writeFileSync(join(directory, '.pi', 'tau.json'), JSON.stringify({ allowedModels: models }));
};

// A linked checkout of the repository, with its own narrower allowlist than the shared root.
const addLinkedCheckout = async (
  onTestFinished: (cleanup: () => void) => void,
  repository: string,
): Promise<string> => {
  writeAllowedModels(repository, judgeModels);
  await git(repository, 'add', '.pi/tau.json');
  await git(repository, 'commit', '--quiet', '-m', 'allow the judge models');

  const checkout = join(temporaryDirectory(onTestFinished, 'tau-shadow-checkout-'), 'checkout');

  await git(repository, 'worktree', 'add', '--quiet', '--detach', checkout, 'HEAD');
  writeAllowedModels(checkout, withoutPanelB);

  return checkout;
};

it("opens the dialog and returns the user's result before judges finish", async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([eligibleQuestion]);

  expect(harness.dialogs).toHaveLength(1);
  expect(harness.registry.classify).not.toHaveBeenCalled();

  harness.latest().handleInput('\r');

  const result = await pending;

  expect(result.details).toEqual(answeredDetails);
  expect(textOf(result)).toBe(answeredText);
  expect(harness.registry.classify).not.toHaveBeenCalled();

  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);
  expect(harness.saved).toEqual([]);

  harness.registry.judgeGate.resolve(undefined);
  await harness.saveStarted.promise;

  expect(harness.saved).toEqual([]);

  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(harness.saved).toHaveLength(1);
});

it('saves one record when the user answers while judges are in flight', async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);

  harness.latest().handleInput('\r');

  const result = await pending;

  expect(result.details).toEqual(answeredDetails);
  expect(textOf(result)).toBe(answeredText);
  expect(harness.saved).toEqual([]);

  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(harness.saved).toHaveLength(1);

  expect(recordOf(harness)).toMatchObject({
    answer: { kind: 'answered', selected: ['Stacked'], typed: false },
  });
});

it('saves a record when judges settle before the answer', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.registry.judgeGate.resolve(undefined);
  await harness.registry.judgeBatchDone.promise;

  expect(harness.preparedDirectories).toEqual([]);
  expect(harness.writeStarted()).toBe(0);
  expect(harness.saved).toEqual([]);

  harness.latest().handleInput('\r');

  await pending;
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(harness.preparedDirectories).toEqual(['questions']);
  expect(harness.writeStarted()).toBe(1);

  expect(recordOf(harness)).toMatchObject({
    version: 1,
    kind: 'shadow',
    cohort: shadowCohort(frozenConfig()),
    sessionId: 'session-shadow-1',
    question: {
      question: eligibleQuestion.question,
      problem: eligibleQuestion.problem,
      impact: eligibleQuestion.impact,
      options: [
        { label: 'Stacked', description: stackedDescription, recommended: true },
        { label: 'Split', description: splitDescription, recommended: false },
      ],
    },
    confidence: null,
    judges: {
      classifier: { verdict: { kind: 'answered', confidence: 0.9 } },
      classifierExamples: { verdict: { kind: 'answered', confidence: 0.9 } },
      panel: { verdict: { kind: 'answered', confidence: 1 } },
      panelExamples: { verdict: { kind: 'answered', confidence: 1 } },
      agent: { verdict: { kind: 'unavailable' }, milliseconds: 0 },
    },
    answer: { kind: 'answered', selected: ['Stacked'], typed: false },
  });
});

it('saves a record when the answer settles before judges', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([eligibleQuestion]);

  harness.latest().handleInput('\r');

  await pending;

  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({
    answer: { kind: 'answered', selected: ['Stacked'], typed: false },
    judges: {
      classifier: { verdict: { kind: 'answered', confidence: 0.9 } },
      panel: { verdict: { kind: 'answered', confidence: 1 } },
    },
  });
});

it('saves a declined answer as declined', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([eligibleQuestion]);

  harness.latest().handleInput('\u001B');

  const result = await pending;

  expect(result.details).toEqual({ kind: 'declined' });

  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({ answer: { kind: 'declined' } });
});

it('saves a declined record when the dialog closes with no result', async ({ onTestFinished }) => {
  const dialogResult = deferred<DialogResult | undefined>();

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    dialogResult,
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  dialogResult.resolve(undefined);

  const result = await pending;

  expect(result.details).toEqual({ kind: 'declined' });

  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(harness.saved).toHaveLength(1);
  expect(recordOf(harness)).toMatchObject({ answer: { kind: 'declined' } });
});

it('uses the supplied confidence for the agent verdict', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([{ ...eligibleQuestion, confidence: 0.7 }]);

  harness.latest().handleInput('\r');
  await pending;

  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({
    confidence: 0.7,
    judges: { agent: { verdict: { kind: 'answered', confidence: 0.7 }, milliseconds: 0 } },
  });
});

it('records a rejected judge as error without changing the result', async ({ onTestFinished }) => {
  const registry = fakeRegistry();

  registry.classify.mockRejectedValue(new Error('judge failed'));

  const harness = await createHarness(onTestFinished, { config: configWithShadow(), registry });

  const pending = harness.run([eligibleQuestion]);

  harness.latest().handleInput('\r');

  const result = await pending;

  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(result.details).toEqual(answeredDetails);

  expect(recordOf(harness)).toMatchObject({
    judges: {
      classifier: { verdict: { kind: 'error' } },
      classifierExamples: { verdict: { kind: 'error' } },
    },
  });
});

it('records the elapsed milliseconds for a clock that advances', async ({ onTestFinished }) => {
  const clock = { now: 0 };
  const registry = fakeRegistry();

  registry.classify.mockImplementation(async () => {
    clock.now += 10;

    return {
      stopReason: 'stop',
      answers: {
        choice: { type: 'choice', choice: 'accept', probabilities: {}, confidence: 0.9 },
      },
    };
  });

  registry.complete.mockImplementation(async () => {
    clock.now += 10;

    return { stopReason: 'stop', content: [{ type: 'text', text: 'Stacked' }] };
  });

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    registry,
    now: () => clock.now,
  });

  const pending = harness.run([eligibleQuestion]);

  harness.latest().handleInput('\r');
  await pending;

  const shadowDone = harness.start();

  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({
    judges: {
      classifier: { milliseconds: 80 },
      classifierExamples: { milliseconds: 70 },
      panel: { milliseconds: 60 },
      panelExamples: { milliseconds: 30 },
    },
  });
});

it('records zero milliseconds when the clock goes backwards', async ({ onTestFinished }) => {
  const clock = { now: 0 };
  const registry = fakeRegistry();

  registry.classify.mockImplementation(async () => {
    clock.now -= 10;

    return {
      stopReason: 'stop',
      answers: {
        choice: { type: 'choice', choice: 'accept', probabilities: {}, confidence: 0.9 },
      },
    };
  });

  registry.complete.mockImplementation(async () => {
    clock.now -= 10;

    return { stopReason: 'stop', content: [{ type: 'text', text: 'Stacked' }] };
  });

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    registry,
    now: () => clock.now,
  });

  const pending = harness.run([eligibleQuestion]);

  harness.latest().handleInput('\r');
  await pending;

  const shadowDone = harness.start();

  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({
    judges: {
      classifier: { milliseconds: 0 },
      classifierExamples: { milliseconds: 0 },
      panel: { milliseconds: 0 },
      panelExamples: { milliseconds: 0 },
    },
  });
});

it('leaves the tool result unchanged when the save fails', async ({ onTestFinished }) => {
  const saveGate = deferred<undefined>();

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    saveGate,
  });

  const pending = harness.run([eligibleQuestion]);

  harness.latest().handleInput('\r');

  const result = await pending;

  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.registry.judgeGate.resolve(undefined);
  await harness.saveStarted.promise;

  saveGate.reject(new Error('disk full'));
  await shadowDone;

  expect(result.details).toEqual(answeredDetails);
  expect(textOf(result)).toBe(answeredText);
  expect(harness.saved).toEqual([]);
});

it('aborts in-flight work and saves no record when the dialog throws', async ({
  onTestFinished,
}) => {
  const rejection = deferred<unknown>();

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    rejectWith: () => rejection.promise,
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.classify).toHaveBeenCalledTimes(2);
  });

  rejection.resolve(new Error('dialog failed'));

  await expect(pending).rejects.toThrow('dialog failed');
  await shadowDone;

  expect(harness.registry.classifierSignals.some((signal) => signal?.aborted === true)).toBe(true);
  expect(harness.saved).toEqual([]);
});

it('saves no record when the dialog fails before the scheduled job starts', async ({
  onTestFinished,
}) => {
  const rejection = deferred<unknown>();

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    rejectWith: () => rejection.promise,
  });

  const pending = harness.run([eligibleQuestion]);

  rejection.resolve(new Error('dialog failed'));

  await expect(pending).rejects.toThrow('dialog failed');
  await harness.start();

  expect(harness.findRootCalls()).toBe(0);
  expect(harness.registry.classify).not.toHaveBeenCalled();
  expect(harness.registry.complete).not.toHaveBeenCalled();
  expect(harness.saved).toEqual([]);
});

it('saves no record when the dialog fails during shared-root preflight', async ({
  onTestFinished,
}) => {
  const findRootGate = deferred<string | undefined>();
  const rejection = deferred<unknown>();

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    findRootGate,
    rejectWith: () => rejection.promise,
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await harness.findRootStarted.promise;
  rejection.resolve(new Error('dialog failed'));
  await expect(pending).rejects.toThrow('dialog failed');

  findRootGate.resolve(undefined);
  await shadowDone;

  expect(harness.registry.classify).not.toHaveBeenCalled();
  expect(harness.registry.complete).not.toHaveBeenCalled();
  expect(harness.saved).toEqual([]);
});

it('saves no record when a preflight that ignores the abort returns a shared root', async ({
  onTestFinished,
}) => {
  const findRootGate = deferred<string | undefined>();
  const rejection = deferred<unknown>();
  let dialogs = 0;

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    findRootGate,
    rejectWith: () => {
      dialogs += 1;

      return dialogs === 1 ? rejection.promise : undefined;
    },
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await harness.findRootStarted.promise;
  rejection.resolve(new Error('dialog failed'));
  await expect(pending).rejects.toThrow('dialog failed');

  const sharedRoot = await findSharedRepositoryRoot(harness.repository);

  findRootGate.resolve(sharedRoot);
  harness.registry.judgeGate.resolve(undefined);
  await shadowDone;

  expect(harness.registry.find).not.toHaveBeenCalled();
  expect(harness.registry.findOfType).not.toHaveBeenCalled();
  expect(harness.registry.classify).not.toHaveBeenCalled();
  expect(harness.registry.complete).not.toHaveBeenCalled();
  expect(harness.saved).toEqual([]);

  const second = harness.run([eligibleQuestion]);
  const secondDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);

  harness.latest().handleInput('\r');
  await second;
  harness.saveGate.resolve(undefined);
  await secondDone;

  expect(harness.saved).toHaveLength(1);
});

it('reads the allowlist of the checkout that asked, not the shared root', async ({
  onTestFinished,
}) => {
  const saveGate = deferred<undefined>();
  const registry = fakeRegistry();

  saveGate.resolve(undefined);
  registry.judgeGate.resolve(undefined);

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    projectTrusted: true,
    saveGate,
    registry,
    prepareRepository: (repository) => addLinkedCheckout(onTestFinished, repository),
  });

  const denied = harness.run([eligibleQuestion]);
  const deniedDone = harness.start();

  harness.latest().handleInput('\r');
  await denied;
  await deniedDone;

  expect(harness.registry.classify).not.toHaveBeenCalled();
  expect(harness.registry.complete).not.toHaveBeenCalled();
  expect(harness.saved).toEqual([]);

  writeAllowedModels(harness.cwd, judgeModels);

  const allowed = harness.run([eligibleQuestion]);
  const allowedDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);

  harness.latest().handleInput('\r');
  await allowed;
  await allowedDone;

  expect(harness.saved).toHaveLength(1);
});

it('ignores the checkout allowlist when the project is untrusted', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    projectTrusted: false,
    prepareRepository: (repository) => addLinkedCheckout(onTestFinished, repository),
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);

  harness.latest().handleInput('\r');
  await pending;
  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(harness.saved).toHaveLength(1);
});

it('saves no record when the dialog fails while directory creation is pending', async ({
  onTestFinished,
}) => {
  const directoryGate = deferred<undefined>();
  const dialogResult = deferred<DialogResult | undefined>();

  const harness = await createHarness(onTestFinished, {
    config: configWithShadow(),
    directoryGate,
    dialogResult,
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.latest().handleInput('\r');
  harness.registry.judgeGate.resolve(undefined);

  await harness.directoryStarted.promise;
  dialogResult.reject(new Error('dialog failed'));
  await expect(pending).rejects.toThrow('dialog failed');

  directoryGate.resolve(undefined);
  await shadowDone;

  expect(harness.saved).toEqual([]);
});

it('saves no record when the dialog aborts while the answer is read', async () => {
  const prepared: string[] = [];
  const saved: ShadowRecord[] = [];
  const registry = fakeRegistry();
  let scheduled: (() => Promise<void>) | undefined;

  registry.judgeGate.resolve(undefined);

  const runner = createShadowRunner({
    now: () => 0,
    findSharedRoot: async () => '/shared-root',
    readConfig: () => frozenConfig(),
    requireModel: () => undefined,
    ensureDirectory: async (_root, path) => {
      prepared.push(path);

      return path;
    },
    writeRecord: async (_path, record) => {
      saved.push(record);
    },
    schedule: (work) => {
      scheduled = work;
    },
  });

  const job = runner.start({
    questions: [{ ...eligibleQuestion, kind: 'choice' as const, multiSelect: false }],
    sessionId: 'session-shadow-1',
    cwd: '/repository',
    projectTrusted: false,
    registry: registry.registry,
  });

  // This getter aborts after run's own abort check, so only save's guard can stop the write.
  const result = {
    kind: 'answered' as const,
    get answers() {
      job.abort();

      return [{ question: eligibleQuestion.question, selected: ['Stacked'], typed: false }];
    },
  };

  job.settle(result);
  await scheduled?.();

  expect(prepared).toEqual([]);
  expect(saved).toEqual([]);
});

const refusedRows: {
  name: string;
  config: unknown;
  question: Record<string, unknown>;
  openWithoutFactory?: boolean;
  git?: boolean;
}[] = [
  { name: 'off', config: configWithoutShadow(), question: eligibleQuestion },
  {
    name: 'ineligible',
    config: configWithShadow(),
    question: { ...eligibleQuestion, kind: 'approval' },
  },
  { name: 'invalid', config: invalidConfig(), question: eligibleQuestion },
  {
    name: 'unopened',
    config: configWithShadow(),
    question: eligibleQuestion,
    openWithoutFactory: true,
  },
  { name: 'missing root', config: configWithShadow(), question: eligibleQuestion, git: false },
  {
    name: 'denied model',
    config: { allowedModels: ['tau-fixture/allowed'], questionGate: frozenConfig() },
    question: eligibleQuestion,
  },
];

for (const row of refusedRows) {
  it(`does not judge or save for ${row.name} calls`, async ({ onTestFinished }) => {
    const harness = await createHarness(onTestFinished, {
      config: row.config,
      git: row.git,
      openWithoutFactory: row.openWithoutFactory,
    });

    const pending = harness.run([row.question]);

    if (row.openWithoutFactory !== true) {
      harness.latest().handleInput('\r');
    }

    await pending;
    await harness.flush();

    expect(harness.registry.classify).not.toHaveBeenCalled();
    expect(harness.registry.complete).not.toHaveBeenCalled();
    expect(harness.saved).toEqual([]);
  });
}

it('starts at most eight provider calls in one batch', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);

  const providerCalls =
    harness.registry.classify.mock.calls.length + harness.registry.complete.mock.calls.length;

  expect(providerCalls).toBe(8);

  harness.latest().handleInput('\r');
  await pending;
  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;
});

it('marks both classifier variants unavailable when the classifier model is missing', async ({
  onTestFinished,
}) => {
  const registry = fakeRegistry({ missingClassifier: true });
  const harness = await createHarness(onTestFinished, { config: configWithShadow(), registry });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  expect(harness.registry.classify).not.toHaveBeenCalled();

  harness.latest().handleInput('\r');
  await pending;
  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({
    judges: {
      classifier: { verdict: { kind: 'unavailable' } },
      classifierExamples: { verdict: { kind: 'unavailable' } },
      panel: { verdict: { kind: 'answered', confidence: 1 } },
      agent: { verdict: { kind: 'unavailable' }, milliseconds: 0 },
    },
  });
});

for (const missingPanel of ['panel-a', 'panel-b', 'panel-c']) {
  it(`skips both panel variants when ${missingPanel} is missing`, async ({ onTestFinished }) => {
    const registry = fakeRegistry({ missingPanel });
    const harness = await createHarness(onTestFinished, { config: configWithShadow(), registry });

    const pending = harness.run([eligibleQuestion]);
    const shadowDone = harness.start();

    await waitFor(() => {
      expect(harness.registry.classify).toHaveBeenCalledTimes(2);
    });

    expect(harness.registry.complete).not.toHaveBeenCalled();

    harness.latest().handleInput('\r');
    await pending;
    harness.registry.judgeGate.resolve(undefined);
    harness.saveGate.resolve(undefined);
    await shadowDone;

    expect(recordOf(harness)).toMatchObject({
      judges: {
        classifier: { verdict: { kind: 'answered', confidence: 0.9 } },
        panel: { verdict: { kind: 'unavailable' } },
        panelExamples: { verdict: { kind: 'unavailable' } },
      },
    });
  });
}

it('marks both examples variants unavailable without examples', async ({ onTestFinished }) => {
  const harness = await createHarness(onTestFinished, {
    config: configWithShadow({ variant: 'classifier', cutoff: 0.8, examples: [] }),
  });

  const pending = harness.run([eligibleQuestion]);
  const shadowDone = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(3);
  });

  expect(harness.registry.classify).toHaveBeenCalledTimes(1);

  harness.latest().handleInput('\r');
  await pending;
  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await shadowDone;

  expect(recordOf(harness)).toMatchObject({
    judges: {
      classifierExamples: { verdict: { kind: 'unavailable' } },
      panelExamples: { verdict: { kind: 'unavailable' } },
    },
  });
});

it('starts at most one batch within 60 seconds and a new batch at the boundary', async ({
  onTestFinished,
}) => {
  const harness = await createHarness(onTestFinished, { config: configWithShadow() });

  harness.clock.now = 0;

  const first = harness.run([eligibleQuestion]);
  const firstShadow = harness.start();

  await waitFor(() => {
    expect(harness.registry.complete).toHaveBeenCalledTimes(6);
  });

  harness.latest().handleInput('\r');
  await first;
  harness.registry.judgeGate.resolve(undefined);
  harness.saveGate.resolve(undefined);
  await firstShadow;

  harness.clock.now = 59_999;

  const second = harness.run([eligibleQuestion]);
  const secondShadow = harness.start();

  harness.latest().handleInput('\r');
  await second;
  await secondShadow;

  expect(harness.registry.classify).toHaveBeenCalledTimes(2);
  expect(harness.saved).toHaveLength(1);

  harness.clock.now = 60_000;

  const third = harness.run([eligibleQuestion]);
  const thirdShadow = harness.start();

  await waitFor(() => {
    expect(harness.registry.classify).toHaveBeenCalledTimes(4);
  });

  harness.latest().handleInput('\r');
  await third;
  await thirdShadow;

  expect(harness.saved).toHaveLength(2);
});

it('discards an answered result without a matching answer', () => {
  const result: DialogResult = {
    kind: 'answered',
    answers: [{ question: 'Another question?', selected: ['Stacked'], typed: false }],
  };

  expect(shadowAnswer(eligibleQuestion.question, result)).toBeUndefined();
});

it('keeps the exact selected labels and typed flag', () => {
  const result: DialogResult = {
    kind: 'answered',
    answers: [{ question: eligibleQuestion.question, selected: ['Stacked', 'Split'], typed: true }],
  };

  expect(shadowAnswer(eligibleQuestion.question, result)).toEqual({
    kind: 'answered',
    selected: ['Stacked', 'Split'],
    typed: true,
  });
});
