import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { ModelRegistry, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import { decideDeadlineMilliseconds } from '../../questionGate/decideDecision.js';
import type { DecisionRecordWriter } from '../../questionGate/decisionRecord.js';
import type { JudgeVerdict } from '../../questionGate/questionGate.js';
import askUserQuestionExtension from './askUserQuestion.js';
import type { DecidePorts } from './decide.js';
import type { DialogResult } from './dialog.js';

interface HarnessOptions {
  config?: QuestionGateConfig | undefined;
  sessionId?: string | null;
  branch?: unknown[];
  verdict?: JudgeVerdict | (() => Promise<JudgeVerdict>);
  writeRecord?: DecisionRecordWriter;
  notify?: (text: string) => void;
  dialogResult?: DialogResult;
}

const eligibleQuestion = {
  question: 'Which layout should the dashboard use?',
  problem: 'The dashboard ships next week.',
  impact: 'Changing the layout later moves every panel.',
  header: 'Layout',
  kind: 'choice',
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

const decideConfig = (
  overrides: Partial<QuestionGateConfig> = {},
): QuestionGateConfig & { shadow: ShadowConfig } => ({
  classifier: 'tau-fixture/classifier',
  panel: ['tau-fixture/panel-a', 'tau-fixture/panel-b', 'tau-fixture/panel-c'],
  decide: true,
  shadow,
  ...overrides,
});

const createHarness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
  const writes: { path: string; record: unknown; mode: number | undefined }[] = [];
  const removals: string[] = [];
  const notices: string[] = [];
  const judgeCalls: unknown[] = [];
  const scheduled: (() => Promise<void>)[] = [];

  const judge = vi.fn<(...args: unknown[]) => Promise<JudgeVerdict>>(async (...args) => {
    judgeCalls.push(args);

    if (typeof options.verdict === 'function') {
      return options.verdict();
    }

    return options.verdict ?? { kind: 'answered', confidence: 0.99 };
  });

  const notify = (text: string) => {
    notices.push(text);
    events.push('notice');
    options.notify?.(text);
  };

  const ports: DecidePorts = {
    now: () => 1_760_000_000_000,
    findSharedRoot: async () => '/shared-root',
    readConfig: () => options.config ?? decideConfig(),
    requireModel: () => undefined,
    readBranch: async () => ({ branch: 'me-1623-decide', head: 'abc1234' }),
    ensureDirectory: async () => '/shared-root/.tau/questions',
    writeRecord: async (path, record, mode) => {
      writes.push({ path, record, mode });
      events.push('write');
      await options.writeRecord?.(path, record, mode);
    },
    removeRecord: async (path) => {
      removals.push(path);
      events.push('remove');
    },
    prepareJudges: () => ({ judge }),
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
    modelRegistry: {} as ModelRegistry,
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

    return tool.execute('call', params, undefined, undefined, context);
  };

  return {
    run,
    events,
    writes,
    removals,
    notices,
    judge,
    judgeCalls,
    custom,
    scheduled,
  };
};

it('answers an eligible call after saving the record and showing the notice', async () => {
  const harness = createHarness();

  const result = await harness.run([eligibleQuestion]);

  harness.events.push('return');

  const written = harness.writes[0];

  expect(written).toBeDefined();
  expect(harness.events).toEqual(['write', 'notice', 'return']);

  expect(harness.notices).toEqual([
    'Decided: Stacked, because One column. Simple, but wide screens waste space.',
  ]);

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

it('asks when the record save fails', async () => {
  const harness = createHarness({
    writeRecord: async () => {
      throw new Error('The record could not be saved.');
    },
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.notices).toEqual([]);
  expect(harness.writes).toHaveLength(1);
});

it('asks and removes the record when the notice fails', async () => {
  const harness = createHarness({
    notify: () => {
      throw new Error('The notice could not be shown.');
    },
  });

  const result = await harness.run([eligibleQuestion]);

  expect(result.details).toEqual(answeredDetails);
  expect(harness.custom).toHaveBeenCalledTimes(1);
  expect(harness.removals).toEqual([harness.writes[0]?.path]);
  expect(harness.events).toEqual(['write', 'notice', 'remove']);
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
