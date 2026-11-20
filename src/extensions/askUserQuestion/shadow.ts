import type { Api, Model } from '@earendil-works/pi-ai';
import { contentText } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { classifyChoice } from '../../classifier/classifier.js';
import type { ConfigLocation } from '../../config/config.js';
import { parseModelReference, requireAllowedModel } from '../../config/models.js';
import { readQuestionGateConfig, shadowCohort } from '../../config/questionGateModels.js';
import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import {
  judgeWithClassifier,
  judgeWithPanel,
  shadowDecision,
  shadowEligibility,
  writeShadowRecord,
} from '../../questionGate/questionGate.js';
import type {
  ClassifyQuestion,
  JudgeQuestion,
  JudgeVerdict,
  PanelMember,
  ShadowRecord,
  ShadowRecordWriter,
} from '../../questionGate/questionGate.js';
import { writeRecord } from '../../record.js';
import { ensureTauDirectory, findSharedRepositoryRoot } from '../../tauDirectory.js';
import type { DialogResult } from './dialog.js';

export interface ShadowQuestion {
  question: string;
  problem: string;
  impact: string;
  kind: 'choice' | 'approval' | undefined;
  confidence: number | undefined;
  multiSelect: boolean;
  preview: string | undefined;
  options: readonly {
    label: string;
    description: string;
    recommended: boolean;
    preview: string | undefined;
  }[];
}

export interface ShadowPorts {
  now: () => number;
  findSharedRoot: (cwd: string, signal: AbortSignal) => Promise<string>;
  readConfig: (location: ConfigLocation) => QuestionGateConfig | undefined;
  requireModel: (reference: string, location: ConfigLocation) => void;
  ensureDirectory: (root: string, path: string) => Promise<string>;
  writeRecord: ShadowRecordWriter;
  schedule: (work: () => Promise<void>) => void;
}

interface ShadowStart {
  questions: readonly ShadowQuestion[];
  sessionId: string;
  cwd: string;
  projectTrusted: boolean;
  registry: ModelRegistry;
}

type ShadowOutcome = { kind: 'saved' } | { kind: 'discarded'; reason: string };

export interface ShadowJob {
  settle: (result: DialogResult) => void;
  abort: () => void;
  completion: Promise<ShadowOutcome>;
}

export interface ShadowRunner {
  start: (request: ShadowStart) => ShadowJob;
}

type FrozenConfig = QuestionGateConfig & { shadow: ShadowConfig };

interface ShadowRate {
  lastBatchStartedAt: number | undefined;
}

interface TimedVerdict {
  verdict: JudgeVerdict;
  milliseconds: number;
}

const defaultShadowPorts: ShadowPorts = {
  now: () => performance.now(),
  findSharedRoot: (cwd, signal) => findSharedRepositoryRoot(cwd, { signal }),
  readConfig: readQuestionGateConfig,
  requireModel: requireAllowedModel,
  ensureDirectory: ensureTauDirectory,
  writeRecord,
  schedule: (work) => {
    setTimeout(() => {
      work().catch(() => undefined);
    }, 0);
  },
};

const judgeQuestionOf = (question: ShadowQuestion): JudgeQuestion => ({
  question: question.question,
  problem: question.problem,
  impact: question.impact,
  options: question.options.map((option) => ({
    label: option.label,
    description: option.description,
    recommended: option.recommended,
  })),
});

export const shadowAnswer = (
  question: string,
  result: DialogResult,
): ShadowRecord['answer'] | undefined => {
  if (result.kind === 'declined') {
    return { kind: 'declined' };
  }

  const answer = result.answers.find((candidate) => candidate.question === question);

  if (answer === undefined) {
    return undefined;
  }

  return { kind: 'answered', selected: [...answer.selected], typed: answer.typed };
};

const timed = async (
  now: () => number,
  work: () => Promise<JudgeVerdict>,
): Promise<TimedVerdict> => {
  const started = now();
  const verdict = await work().catch((): JudgeVerdict => ({ kind: 'error' }));
  const milliseconds = Math.max(0, now() - started);

  return { verdict, milliseconds };
};

const panelModelsOf = (
  registry: ModelRegistry,
  references: readonly [string, string, string],
): [Model<Api>, Model<Api>, Model<Api>] | undefined => {
  const [first, second, third] = references.map((reference) => {
    const parsed = parseModelReference(reference);

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model ID, not an array predicate and thisArg.
    return parsed === undefined ? undefined : registry.find(parsed.provider, parsed.id);
  });

  if (first === undefined || second === undefined || third === undefined) {
    return undefined;
  }

  return [first, second, third];
};

const panelMember = (registry: ModelRegistry, model: Model<Api>): PanelMember => {
  return async (prompt, signal) => {
    try {
      const reply = await registry.complete(
        model,
        {
          systemPrompt: prompt.system,
          messages: [{ role: 'user', content: prompt.user, timestamp: Date.now() }],
        },
        { signal },
      );

      if (reply.stopReason !== 'stop') {
        return { kind: 'error' };
      }

      return { kind: 'replied', text: contentText(reply.content).trim() };
    } catch {
      return { kind: 'error' };
    }
  };
};

const agentVerdict = (confidence: number | undefined): JudgeVerdict =>
  confidence === undefined ? { kind: 'unavailable' } : { kind: 'answered', confidence };

const judgeAll = async (
  ports: ShadowPorts,
  request: ShadowStart,
  config: FrozenConfig,
  question: ShadowQuestion,
  signal: AbortSignal,
): Promise<ShadowRecord['judges']> => {
  const examples = config.shadow.examples;
  const hasExamples = examples.length > 0;
  const panelModels = panelModelsOf(request.registry, config.panel);
  const judgeQuestion = judgeQuestionOf(question);

  const classify: ClassifyQuestion = (state, choiceQuestion, judgeSignal) =>
    classifyChoice(
      { modelRegistry: request.registry },
      config.classifier,
      state,
      choiceQuestion,
      judgeSignal,
    );

  const unavailable: JudgeVerdict = { kind: 'unavailable' };

  const classifierWork = (useExamples: boolean): Promise<JudgeVerdict> => {
    const missingExamples = useExamples && !hasExamples;

    if (missingExamples) {
      return Promise.resolve(unavailable);
    }

    const chosenExamples = useExamples ? examples : [];

    return judgeWithClassifier(classify, judgeQuestion, chosenExamples, signal);
  };

  const panelWork = (useExamples: boolean): Promise<JudgeVerdict> => {
    const missingExamples = useExamples && !hasExamples;

    if (panelModels === undefined || missingExamples) {
      return Promise.resolve(unavailable);
    }

    const members: [PanelMember, PanelMember, PanelMember] = [
      panelMember(request.registry, panelModels[0]),
      panelMember(request.registry, panelModels[1]),
      panelMember(request.registry, panelModels[2]),
    ];

    const chosenExamples = useExamples ? examples : [];

    return judgeWithPanel(members, judgeQuestion, chosenExamples, signal);
  };

  const [classifier, classifierExamples, panel, panelExamples] = await Promise.all([
    timed(ports.now, () => classifierWork(false)),
    timed(ports.now, () => classifierWork(true)),
    timed(ports.now, () => panelWork(false)),
    timed(ports.now, () => panelWork(true)),
  ]);

  return {
    classifier,
    classifierExamples,
    panel,
    panelExamples,
    agent: { verdict: agentVerdict(question.confidence), milliseconds: 0 },
  };
};

const startShadowJob = (request: ShadowStart, ports: ShadowPorts, rate: ShadowRate): ShadowJob => {
  const answer = Promise.withResolvers<DialogResult | undefined>();
  const controller = new AbortController();
  const isAborted = () => controller.signal.aborted;
  let settled = false;

  const preflight = async (): Promise<{ sharedRoot: string; config: FrozenConfig } | undefined> => {
    try {
      const sharedRoot = await ports.findSharedRoot(request.cwd, controller.signal);

      const location: ConfigLocation = {
        cwd: sharedRoot,
        agentDirectory: getAgentDir(),
        projectTrusted: request.projectTrusted,
      };

      const read = ports.readConfig(location);

      if (read?.shadow === undefined) {
        return undefined;
      }

      for (const reference of [read.classifier, ...read.panel]) {
        ports.requireModel(reference, location);
      }

      return { sharedRoot, config: { ...read, shadow: read.shadow } };
    } catch {
      return undefined;
    }
  };

  const save = async (
    sharedRoot: string,
    config: FrozenConfig,
    question: ShadowQuestion,
    judges: ShadowRecord['judges'],
    result: DialogResult,
  ): Promise<ShadowOutcome> => {
    const recordAnswer = shadowAnswer(question.question, result);

    if (recordAnswer === undefined) {
      return { kind: 'discarded', reason: 'answer' };
    }

    if (isAborted()) {
      return { kind: 'discarded', reason: 'aborted' };
    }

    const record: ShadowRecord = {
      version: 1,
      kind: 'shadow',
      cohort: shadowCohort(config),
      sessionId: request.sessionId,
      question: judgeQuestionOf(question),
      confidence: question.confidence ?? null,
      judges,
      answer: recordAnswer,
    };

    try {
      const directory = await ports.ensureDirectory(sharedRoot, 'questions');

      if (isAborted()) {
        return { kind: 'discarded', reason: 'aborted' };
      }

      await writeShadowRecord(directory, record, ports.writeRecord);
    } catch {
      return { kind: 'discarded', reason: 'save' };
    }

    return { kind: 'saved' };
  };

  const run = async (): Promise<ShadowOutcome> => {
    if (isAborted()) {
      return { kind: 'discarded', reason: 'aborted' };
    }

    const eligibility = shadowEligibility(request.questions);

    if (eligibility.kind === 'skip') {
      return { kind: 'discarded', reason: eligibility.reason };
    }

    const prepared = await preflight();

    if (prepared === undefined) {
      return { kind: 'discarded', reason: 'preflight' };
    }

    if (isAborted()) {
      return { kind: 'discarded', reason: 'aborted' };
    }

    const now = ports.now();

    const decision = shadowDecision({
      questions: request.questions,
      lastBatchStartedAt: rate.lastBatchStartedAt,
      now,
    });

    if (decision.kind === 'skip') {
      return { kind: 'discarded', reason: decision.reason };
    }

    rate.lastBatchStartedAt = now;

    const question = request.questions[0];

    if (question === undefined) {
      return { kind: 'discarded', reason: 'multipleQuestions' };
    }

    const judges = await judgeAll(ports, request, prepared.config, question, controller.signal);
    const result = await answer.promise;

    if (isAborted() || result === undefined) {
      return { kind: 'discarded', reason: 'aborted' };
    }

    return save(prepared.sharedRoot, prepared.config, question, judges, result);
  };

  const completion = new Promise<ShadowOutcome>((resolve) => {
    ports.schedule(async () => {
      const outcome = await run().catch((): ShadowOutcome => ({
        kind: 'discarded',
        reason: 'error',
      }));

      resolve(outcome);
    });
  });

  return {
    settle: (result) => {
      if (settled || isAborted()) {
        return;
      }

      settled = true;
      answer.resolve(result);
    },
    abort: () => {
      if (isAborted()) {
        return;
      }

      controller.abort();
      answer.resolve(undefined);
    },
    completion,
  };
};

export const createShadowRunner = (overrides: Partial<ShadowPorts> = {}): ShadowRunner => {
  const ports: ShadowPorts = { ...defaultShadowPorts, ...overrides };
  const rate: ShadowRate = { lastBatchStartedAt: undefined };

  return { start: (request) => startShadowJob(request, ports, rate) };
};
