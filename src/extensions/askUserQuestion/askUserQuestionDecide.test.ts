import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ModelRegistry, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import type { ConfigLocation } from '../../config/config.js';
import { requireAllowedModel } from '../../config/models.js';
import { readQuestionGateConfig } from '../../config/questionGateModels.js';
import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import { errorMessage } from '../../errors.js';
import { decideDeadlineMilliseconds } from '../../questionGate/decideDecision.js';
import type { DecisionRecordWriter } from '../../questionGate/decision/decisionRecord.js';
import type { DecisionRecord, JudgeVerdict } from '../../questionGate/questionGate.js';
import askUserQuestionExtension from './askUserQuestion.js';
import { createDecider } from './decide.js';
import type { DecidePorts } from './decide.js';
import type { DialogResult } from './dialog.js';
import { prepareJudges } from './judges.js';

interface HarnessOptions {
  config?: QuestionGateConfig | undefined;
  sessionId?: string | null;
  branch?: unknown[];
  verdict?: JudgeVerdict | (() => Promise<JudgeVerdict>);
  writeRecord?: DecisionRecordWriter;
  notify?: (text: string) => void;
  dialogResult?: DialogResult;
  prepareJudges?: DecidePorts['prepareJudges'];
  registry?: ModelRegistry;
  signal?: AbortSignal;
  readBranch?: DecidePorts['readBranch'];
  requireModel?: DecidePorts['requireModel'];
  ensureDirectory?: DecidePorts['ensureDirectory'];
  now?: DecidePorts['now'];
  random?: DecidePorts['random'];
  readConfig?: DecidePorts['readConfig'];
}

const eligibleQuestion = {
  question: 'Which layout should the dashboard use?',
  problem: 'The dashboard ships next week.',
  impact: 'Changing the layout later moves every panel.',
  header: 'Layout',
  kind: 'choice' as const,
  confidence: 0.99,
  options: [
    {
      label: 'Stacked',
      description: 'One column. Simple, but wide screens waste space.',
      recommended: true,
    },
    {
      label: 'Split',
      description: 'Two columns. Uses wide screens, but needs a fallback.',
    },
  ],
};

const shadow: ShadowConfig = { variant: 'agent', cutoff: 0.9, examples: [] };

const neverAudit = () => 1;

const decideConfig = (
  overrides: Partial<QuestionGateConfig> = {},
): QuestionGateConfig & { shadow: ShadowConfig } => ({
  classifier: 'tau-fixture/classifier',
  panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
  decide: true,
  shadow,
  ...overrides,
});

const noticeLines = (notices: readonly string[]): string[] =>
  notices.flatMap((notice) => notice.split('\n'));

const createHarness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
  const writes: { path: string; record: unknown; mode: number | undefined }[] = [];
  const notices: string[] = [];
  const noticeLevels: (string | undefined)[] = [];
  const judgeCalls: unknown[][] = [];
  const scheduled: (() => Promise<void>)[] = [];

  const judge = vi.fn<(...args: unknown[]) => Promise<JudgeVerdict>>(async (...args) => {
    judgeCalls.push(args);

    if (typeof options.verdict === 'function') {
      return options.verdict();
    }

    return options.verdict ?? { kind: 'answered', confidence: 0.99 };
  });

  const notify = (text: string, level?: string) => {
    notices.push(text);
    noticeLevels.push(level);
    events.push('notice');
    options.notify?.(text);
  };

  const ports: DecidePorts = {
    now: options.now ?? (() => 1_760_000_000_000),
    random: options.random ?? neverAudit,
    findSharedRoot: async () => '/shared-root',
    readConfig: options.readConfig ?? (() => options.config ?? decideConfig()),
    requireModel: options.requireModel ?? (() => undefined),
    readBranch: options.readBranch ?? (async () => ({ branch: 'me-1623-decide', head: 'abc1234' })),
    ensureDirectory: options.ensureDirectory ?? (async () => '/shared-root/.tau/questions'),
    writeRecord: async (path, record, mode) => {
      writes.push({ path, record, mode });
      events.push('write');
      await options.writeRecord?.(path, record, mode);
    },
    prepareJudges: options.prepareJudges ?? (() => ({ judge })),
  };

  const fake = fakeExtensionApi();

  askUserQuestionExtension(fake.pi, {
    decide: ports,
    shadow: {
      schedule: (work) => {
        scheduled.push(work);
      },
    },
  });

  const dialogResult: DialogResult = options.dialogResult ?? {
    kind: 'answered',
    answers: [
      {
        question: eligibleQuestion.question,
        selected: ['Stacked'],
        typed: false,
      },
    ],
  };

  const custom = vi.fn<() => Promise<DialogResult>>().mockResolvedValue(dialogResult);

  const context = {
    mode: 'tui',
    cwd: '/checkout',
    isProjectTrusted: () => false,
    modelRegistry: options.registry ?? ({} as ModelRegistry),
    ui: { custom, notify },
    sessionManager: {
      getSessionId: () =>
        options.sessionId === null ? undefined : (options.sessionId ?? 'session-decide-1'),
      getBranch: () => options.branch ?? [],
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

    return tool.execute('call', params, options.signal, undefined, context);
  };

  return {
    run,
    events,
    writes,
    notices,
    noticeLevels,
    judge,
    judgeCalls,
    custom,
    scheduled,
  };
};

const createFileBackedHarness = (
  onTestFinished: (cleanup: () => void) => void,
  writeUser?: (config: ReturnType<typeof temporaryTauConfig>) => void,
  options: HarnessOptions = {},
) => {
  const config = temporaryTauConfig(onTestFinished, 'tau-decide-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', config.location.agentDirectory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeUser?.(config);

  const harness = createHarness({
    ...options,
    readConfig: readQuestionGateConfig,
    requireModel: requireAllowedModel,
  });

  return { config, harness };
};

const configErrorMessage = (location: ConfigLocation): string => {
  try {
    readQuestionGateConfig(location, { notify: () => undefined });
  } catch (error) {
    return errorMessage(error);
  }

  throw new Error('The config did not fail.');
};

it('answers an eligible call after showing the notice and saving the record', async () => {
  const writeStarted = Promise.withResolvers<undefined>();
  const save = Promise.withResolvers<undefined>();

  const harness = createHarness({
    writeRecord: () => {
      writeStarted.resolve(undefined);

      return save.promise;
    },
  });

  const pending = harness.run([eligibleQuestion]);

  await writeStarted.promise;

  expect(harness.events).toEqual(['notice', 'write']);

  let settled = false;

  const tracked = pending.then((result) => {
    settled = true;

    return result;
  });

  const flushed = Promise.withResolvers<undefined>();

  queueMicrotask(() => {
    flushed.resolve(undefined);
  });

  await flushed.promise;

  expect(settled).toBe(false);

  save.resolve(undefined);

  const result = await tracked;

  harness.events.push('return');

  const written = harness.writes[0];

  expect(written).toBeDefined();
  expect(harness.events).toEqual(['notice', 'write', 'return']);

  expect(noticeLines(harness.notices)).toEqual([expect.stringContaining('Stacked')]);
  expect(harness.noticeLevels).toEqual(['info']);

  expect(result.details).toEqual({
    kind: 'decided',
    answers: [
      {
        question: eligibleQuestion.question,
        selected: ['Stacked'],
        typed: false,
      },
    ],
    record: written?.path,
  });

  const text = (result.content as { type: string; text: string }[])
    .map((item) => item.text)
    .join('\n');

  const lower = text.toLowerCase();

  expect(lower).toContain('question gate answered');

  expect(lower).toMatch(
    /\b(?:not|never)\b[^.]*\b(?:approv|authoriz)\w*[^.]*\bpublishing\b[^.]*\bpushing\b[^.]*\bposting\b/,
  );

  expect(harness.custom).not.toHaveBeenCalled();
  expect(harness.scheduled).toEqual([]);

  expect(written?.record).toMatchObject({
    version: 1,
    kind: 'decision',
    time: 1_760_000_000_000,
    sessionId: 'session-decide-1',
    branch: 'me-1623-decide',
    head: 'abc1234',
    variant: 'agent',
    cutoff: 0.9,
  });
});

it('cancels during judging without a notice, record, or dialog', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const controller = new AbortController();
  const judgeStarted = Promise.withResolvers<undefined>();

  const harness = createHarness({
    signal: controller.signal,
    verdict: () => {
      judgeStarted.resolve(undefined);

      return new Promise<JudgeVerdict>(() => {
        // The judge ignores the abort signal and never settles.
      });
    },
  });

  const pending = harness.run([eligibleQuestion]);
  const cancelled = pending.catch((error: unknown) => error);

  await judgeStarted.promise;
  controller.abort();
  await vi.advanceTimersByTimeAsync(decideDeadlineMilliseconds);

  const error = await cancelled;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/cancelled/i);

  expect(harness.notices).toEqual([]);
  expect(harness.writes).toEqual([]);
  expect(harness.custom).not.toHaveBeenCalled();
});

it('cancels after judging before the notice or record', async () => {
  const controller = new AbortController();
  const branchStarted = Promise.withResolvers<undefined>();
  const branchGate = Promise.withResolvers<{ branch: string | null; head: string | null }>();

  const harness = createHarness({
    signal: controller.signal,
    readBranch: async () => {
      branchStarted.resolve(undefined);

      return branchGate.promise;
    },
  });

  const pending = harness.run([eligibleQuestion]);
  const cancelled = pending.catch((error: unknown) => error);

  await branchStarted.promise;
  controller.abort();
  branchGate.resolve({ branch: 'me-1623-decide', head: 'abc1234' });

  const error = await cancelled;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/cancelled/i);

  expect(harness.notices).toEqual([]);
  expect(harness.writes).toEqual([]);
  expect(harness.custom).not.toHaveBeenCalled();
});

it('asks without a notice when the user config has no question gate', async ({
  onTestFinished,
}) => {
  const { harness } = createFileBackedHarness(onTestFinished);

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toEqual([]);
  expect(harness.writes).toEqual([]);
});

it('reports decide without a shadow block once and still asks the question', async ({
  onTestFinished,
}) => {
  const { config, harness } = createFileBackedHarness(onTestFinished, ({ writeUser }) => {
    writeUser({
      questionGate: {
        classifier: 'tau-fixture/classifier',
        panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
        decide: true,
      },
    });
  });

  const expected = configErrorMessage({
    cwd: '/checkout',
    agentDirectory: config.location.agentDirectory,
    projectTrusted: false,
  });

  const first = await harness.run([eligibleQuestion]);

  expect(first.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toHaveLength(1);
  expect(harness.noticeLevels).toEqual(['error']);
  expect(harness.notices[0]).toContain(config.userFile);
  expect(harness.notices[0]).toContain(expected);
  expect(harness.writes).toEqual([]);

  const second = await harness.run([eligibleQuestion]);

  expect(second.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(2);
  expect(harness.notices).toHaveLength(1);
  expect(harness.writes).toEqual([]);
});

it('opens the dialog when the refusal notice throws', async ({ onTestFinished }) => {
  const { harness } = createFileBackedHarness(
    onTestFinished,
    ({ writeUser }) => {
      writeUser({
        questionGate: {
          classifier: 'tau-fixture/classifier',
          panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
          decide: true,
        },
      });
    },
    {
      notify: () => {
        throw new Error('The notice could not be shown.');
      },
    },
  );

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toHaveLength(1);
  expect(harness.writes).toEqual([]);
});

it('reports a refused decide variant model once and still asks the question', async ({
  onTestFinished,
}) => {
  const { config, harness } = createFileBackedHarness(onTestFinished, ({ writeUser }) => {
    writeUser({
      allowedModels: ['tau-fixture/allowed'],
      questionGate: decideConfig({
        classifier: 'tau-fixture/blocked',
        shadow: { ...shadow, variant: 'classifier' },
      }),
    });
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.judge).not.toHaveBeenCalled();
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toHaveLength(1);
  expect(harness.noticeLevels).toEqual(['error']);
  expect(harness.notices[0]).toContain('tau-fixture/blocked');
  expect(harness.notices[0]).toContain(config.userFile);
  expect(harness.writes).toEqual([]);
});

const multiQuestion = (
  question: string,
  header: string,
  confidence: number,
  recommendedLabel: string,
) => ({
  question,
  problem: 'The team must choose before the next release.',
  impact: 'The choice changes the next release.',
  header,
  kind: 'choice' as const,
  confidence,
  options: [
    { label: 'Stacked', description: 'One column. Simple, but wide screens waste space.' },
    {
      label: recommendedLabel,
      description: 'Uses wide screens, but needs a fallback.',
      recommended: true,
    },
  ],
});

it('asks a batch of eligible questions instead of deciding it', async () => {
  const questions = [
    multiQuestion('Which layout should the dashboard use?', 'Layout', 0.8, 'Split'),
    multiQuestion('Which font should the report use?', 'Font', 0.9, 'Serif'),
  ];

  const harness = createHarness();

  const result = await harness.run(questions);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.judge).not.toHaveBeenCalled();
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toEqual([]);
  expect(harness.writes).toEqual([]);
});

it('asks an audited decision without a notice or a decision record', async () => {
  const harness = createHarness({ random: () => 0.1 });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.judge).toHaveBeenCalledTimes(1);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toEqual([]);
  expect(harness.writes).toEqual([]);
});

it('cancels before the notice without a notice, record, or dialog', async () => {
  const controller = new AbortController();

  const harness = createHarness({
    signal: controller.signal,
    now: () => {
      controller.abort();

      return 1_760_000_000_000;
    },
  });

  const cancelled = harness.run([eligibleQuestion]).catch((error: unknown) => error);
  const error = await cancelled;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/cancelled/i);

  expect(harness.notices).toEqual([]);
  expect(harness.writes).toEqual([]);
  expect(harness.custom).not.toHaveBeenCalled();
});

it('finishes the record when the signal aborts while ensuring the directory', async () => {
  const controller = new AbortController();

  const harness = createHarness({
    signal: controller.signal,
    ensureDirectory: async () => {
      controller.abort();

      return '/shared-root/.tau/questions';
    },
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toMatchObject({
    kind: 'decided',
    record: harness.writes[0]?.path,
  });

  expect(noticeLines(harness.notices)).toEqual([expect.stringContaining('Stacked')]);

  expect(harness.events).toEqual(['notice', 'write']);
  expect(harness.writes).toHaveLength(1);
  expect(harness.custom).not.toHaveBeenCalled();
});

it('asks when the record save fails after the notice without an abort', async () => {
  const controller = new AbortController();

  const harness = createHarness({
    signal: controller.signal,
    writeRecord: async () => {
      throw new Error('The record could not be saved.');
    },
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toHaveLength(1);
  expect(harness.writes).toHaveLength(1);
});

it('cancels without a dialog when the record save fails after an abort', async () => {
  const controller = new AbortController();

  const harness = createHarness({
    signal: controller.signal,
    writeRecord: async () => {
      controller.abort();

      throw new Error('The record could not be saved.');
    },
  });

  const cancelled = harness.run([eligibleQuestion]).catch((error: unknown) => error);
  const error = await cancelled;

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/cancelled/i);

  expect(harness.notices).toHaveLength(1);
  expect(harness.writes).toHaveLength(1);
  expect(harness.custom).not.toHaveBeenCalled();
});

it('reads an attached, a detached, and an unborn HEAD through the default Git adapter', async ({
  onTestFinished,
}) => {
  const repository = await createTemporaryRepository(onTestFinished);
  const records: DecisionRecord[] = [];

  const decider = createDecider({
    now: () => 1_760_000_000_000,
    findSharedRoot: async () => '/shared-root',
    readConfig: () => decideConfig(),
    requireModel: () => undefined,
    ensureDirectory: async () => '/shared-root/.tau/questions',
    writeRecord: async (_path, record) => {
      records.push(record);
    },
    prepareJudges: () => ({
      judge: async () => ({ kind: 'answered', confidence: 0.99 }),
    }),
  });

  const decide = async () => {
    const outcome = await decider.tryDecide({
      questions: [{ ...eligibleQuestion, multiSelect: false }],
      sessionId: 'session-decide-1',
      cwd: repository,
      projectTrusted: false,
      registry: {} as ModelRegistry,
      signal: undefined,
      ui: { notify: () => undefined },
    });

    expect(outcome?.kind).toBe('decided');

    return records.at(-1);
  };

  const unborn = await decide();

  expect(unborn).toMatchObject({ branch: 'main', head: null });

  await git(repository, 'commit', '--allow-empty', '--quiet', '-m', 'initial');

  const head = await git(repository, 'rev-parse', 'HEAD');
  const attached = await decide();

  expect(attached).toMatchObject({ branch: 'main', head });

  await git(repository, 'checkout', '--quiet', '--detach');

  const detached = await decide();

  expect(detached).toMatchObject({ branch: null, head });
});

const answeredDetails = {
  kind: 'answered',
  answers: [
    {
      question: eligibleQuestion.question,
      selected: ['Stacked'],
      typed: false,
    },
  ],
};

const decidedEntry = (typed: boolean) => ({
  type: 'message',
  message: {
    role: 'toolResult',
    toolName: 'ask_user_question',
    details: {
      kind: 'decided',
      answers: [{ question: eligibleQuestion.question, selected: ['Stacked'], typed }],
      record: '/shared-root/.tau/questions/decision-old.json',
    },
  },
});

const typedEntry = {
  type: 'message',
  message: {
    role: 'toolResult',
    toolName: 'ask_user_question',
    details: {
      kind: 'answered',
      answers: [{ question: eligibleQuestion.question, selected: ['Stacked'], typed: true }],
    },
  },
};

afterEach(() => {
  vi.useRealTimers();
});

it('asks when the record save fails after the notice', async () => {
  const harness = createHarness({
    writeRecord: async () => {
      throw new Error('The record could not be saved.');
    },
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);

  expect(noticeLines(harness.notices)).toEqual([expect.stringContaining('Stacked')]);

  expect(harness.events).toEqual(['notice', 'write']);
  expect(harness.writes).toHaveLength(1);
});

it('asks without writing when the notice fails', async () => {
  const harness = createHarness({
    notify: () => {
      throw new Error('The notice could not be shown.');
    },
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.writes).toEqual([]);
  expect(harness.events).toEqual(['notice']);
});

it('asks below the cutoff', async () => {
  const harness = createHarness({ verdict: { kind: 'answered', confidence: 0.5 } });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.judge).toHaveBeenCalledTimes(1);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.writes).toEqual([]);
  expect(harness.notices).toEqual([]);
});

it('passes the question confidence to the agent judge', async () => {
  const harness = createHarness({
    prepareJudges,
    registry: { find: () => undefined } as unknown as ModelRegistry,
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual({
    kind: 'decided',
    answers: [
      {
        question: eligibleQuestion.question,
        selected: ['Stacked'],
        typed: false,
      },
    ],
    record: harness.writes[0]?.path,
  });

  expect(harness.writes[0]?.record).toMatchObject({
    decisions: [{ confidence: 0.99 }],
  });
});

it('aborts the judge signal when the deadline passes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const harness = createHarness({
    verdict: () =>
      new Promise<JudgeVerdict>(() => {
        // The judge ignores the abort signal and never settles.
      }),
  });

  const pending = harness.run([eligibleQuestion]);

  await vi.advanceTimersByTimeAsync(decideDeadlineMilliseconds);

  await pending;

  const signal = harness.judgeCalls[0]?.[3];

  if (!(signal instanceof AbortSignal)) {
    throw new Error('The judge received no abort signal.');
  }

  expect(signal.aborted).toBe(true);
});

it('clears the deadline timer once the call settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const harness = createHarness();

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toMatchObject({ kind: 'decided' });
  expect(vi.getTimerCount()).toBe(0);
});

it('asks when the judge misses the deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const harness = createHarness({
    verdict: () =>
      new Promise<JudgeVerdict>(() => {
        // The judge ignores the abort signal and never settles.
      }),
  });

  const pending = harness.run([eligibleQuestion]);

  await vi.advanceTimersByTimeAsync(decideDeadlineMilliseconds);

  const result = await pending;

  expect(result.details).toEqual(answeredDetails);
  expect(harness.judge).toHaveBeenCalledTimes(1);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.writes).toEqual([]);
});

it.each([
  {
    name: 'decide is off',
    options: { config: decideConfig({ decide: false }) },
  },
  {
    name: 'the question is an approval',
    options: {},
    question: { ...eligibleQuestion, kind: 'approval' as const },
  },
  {
    name: 'there is no session ID',
    options: { sessionId: null },
  },
])('asks without judging when $name', async ({ options, question }) => {
  const harness = createHarness(options);

  const result = await harness.run([question ?? eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.judge).not.toHaveBeenCalled();
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.writes).toEqual([]);
  expect(harness.notices).toEqual([]);
});

it('keeps an older typed answer visible after a decided result', async () => {
  const refusing = createHarness({
    branch: [typedEntry, decidedEntry(false)],
    config: decideConfig({ decide: false }),
  });

  await expect(refusing.run([eligibleQuestion])).rejects.toThrow('last answer was typed text');
  expect(refusing.custom).not.toHaveBeenCalled();

  const allowed = createHarness({
    branch: [decidedEntry(true)],
    config: decideConfig({ decide: false }),
  });

  const result = await allowed.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(allowed.custom).toHaveBeenCalledTimes(1);
});
