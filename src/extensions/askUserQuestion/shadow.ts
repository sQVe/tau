import type { Api, Model } from '@earendil-works/pi-ai';
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
  panelMember,
  shadowEligibility,
  shadowRateAllows,
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
import type { DialogQuestion, DialogResult } from './dialog.js';

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
  questions: readonly (DialogQuestion & {
    kind?: 'choice' | 'approval' | undefined;
    confidence?: number | undefined;
  })[];
  sessionId: string;
  cwd: string;
  projectTrusted: boolean;
  registry: ModelRegistry;
}

export interface ShadowJob {
  settle: (result: DialogResult) => void;
  abort: () => void;
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

const judgeQuestionOf = (
  question: DialogQuestion & { confidence?: number | undefined },
): JudgeQuestion => ({
  question: question.question,
  problem: question.problem,
  impact: question.impact,
  options: question.options.map((option) => ({
    label: option.label,
    description: option.description,
    recommended: option.recommended === true,
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

const agentVerdict = (confidence: number | undefined): JudgeVerdict =>
  confidence === undefined ? { kind: 'unavailable' } : { kind: 'answered', confidence };

const judgeAll = async (
  ports: ShadowPorts,
  request: ShadowStart,
  config: FrozenConfig,
  question: JudgeQuestion,
  confidence: number | undefined,
  signal: AbortSignal,
): Promise<ShadowRecord['judges']> => {
  const examples = config.shadow.examples;
  const hasExamples = examples.length > 0;
  const panelModels = panelModelsOf(request.registry, config.panel);

  const members: [PanelMember, PanelMember, PanelMember] | undefined =
    panelModels === undefined
      ? undefined
      : [
          panelMember(request.registry, panelModels[0]),
          panelMember(request.registry, panelModels[1]),
          panelMember(request.registry, panelModels[2]),
        ];

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

    return judgeWithClassifier(classify, question, chosenExamples, signal);
  };

  const panelWork = (useExamples: boolean): Promise<JudgeVerdict> => {
    const missingExamples = useExamples && !hasExamples;

    if (members === undefined || missingExamples) {
      return Promise.resolve(unavailable);
    }

    const chosenExamples = useExamples ? examples : [];

    return judgeWithPanel(members, question, chosenExamples, signal);
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
    agent: { verdict: agentVerdict(confidence), milliseconds: 0 },
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
        cwd: request.cwd,
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
    question: JudgeQuestion,
    confidence: number | undefined,
    judges: ShadowRecord['judges'],
    result: DialogResult,
  ): Promise<void> => {
    const recordAnswer = shadowAnswer(question.question, result);

    if (recordAnswer === undefined) {
      return;
    }

    if (isAborted()) {
      return;
    }

    const record: ShadowRecord = {
      version: 1,
      kind: 'shadow',
      cohort: shadowCohort(config),
      sessionId: request.sessionId,
      question,
      confidence: confidence ?? null,
      judges,
      answer: recordAnswer,
    };

    try {
      const directory = await ports.ensureDirectory(sharedRoot, 'questions');

      if (isAborted()) {
        return;
      }

      await writeShadowRecord(directory, record, ports.writeRecord);
    } catch {
      return;
    }
  };

  const run = async (): Promise<void> => {
    if (isAborted()) {
      return;
    }

    const eligibility = shadowEligibility(request.questions);

    if (eligibility.kind === 'skip') {
      return;
    }

    const prepared = await preflight();

    if (prepared === undefined) {
      return;
    }

    if (isAborted()) {
      return;
    }

    const now = ports.now();

    if (!shadowRateAllows(rate.lastBatchStartedAt, now)) {
      return;
    }

    rate.lastBatchStartedAt = now;

    const question = eligibility.question;
    const judgeQuestion = judgeQuestionOf(question);

    const judges = await judgeAll(
      ports,
      request,
      prepared.config,
      judgeQuestion,
      question.confidence,
      controller.signal,
    );

    const result = await answer.promise;

    if (isAborted() || result === undefined) {
      return;
    }

    await save(
      prepared.sharedRoot,
      prepared.config,
      judgeQuestion,
      question.confidence,
      judges,
      result,
    );
  };

  ports.schedule(run);

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
  };
};

export const createShadowRunner = (overrides: Partial<ShadowPorts> = {}): ShadowRunner => {
  const ports: ShadowPorts = { ...defaultShadowPorts, ...overrides };
  const rate: ShadowRate = { lastBatchStartedAt: undefined };

  return { start: (request) => startShadowJob(request, ports, rate) };
};
