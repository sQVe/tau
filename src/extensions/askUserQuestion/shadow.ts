import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { notifyOnce, userConfigPath } from '../../config/config.js';
import { requireAllowedModel } from '../../config/models.js';
import { readQuestionGateShadow, shadowCohort } from '../../config/questionGateModels.js';
import type { QuestionGateShadow } from '../../config/questionGateModels.js';
import { errorMessage } from '../../errors.js';
import {
  shadowEligibility,
  shadowRateAllows,
  writeShadowRecord,
} from '../../questionGate/questionGate.js';
import type {
  JudgeQuestion,
  JudgeVerdict,
  ShadowRecord,
  ShadowRecordWriter,
} from '../../questionGate/questionGate.js';
import { writeRecord } from '../../record.js';
import { ensureTauDirectory, findSharedRepositoryRoot } from '../../tauDirectory.js';
import type { AskedQuestion, DialogResult } from './dialog.js';
import { judgeQuestionOf, prepareJudges } from './judges.js';

export interface ShadowPorts {
  now: () => number;
  findSharedRoot: (cwd: string, signal: AbortSignal) => Promise<string>;
  readConfig: (location: ConfigLocation, ui: ConfigWarnings) => QuestionGateShadow | undefined;
  requireModel: (reference: string, location: ConfigLocation) => void;
  ensureDirectory: (root: string, path: string) => Promise<string>;
  writeRecord: ShadowRecordWriter;
  schedule: (work: () => Promise<void>) => void;
}

interface ShadowStart {
  questions: readonly AskedQuestion[];
  sessionId: string;
  cwd: string;
  projectTrusted: boolean;
  registry: ModelRegistry;
  ui: ConfigWarnings;
}

export interface ShadowJob {
  settle: (result: DialogResult) => void;
  abort: () => void;
}

export interface ShadowRunner {
  start: (request: ShadowStart) => ShadowJob;
}

type FrozenConfig = QuestionGateShadow;

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
  readConfig: readQuestionGateShadow,
  requireModel: requireAllowedModel,
  ensureDirectory: ensureTauDirectory,
  writeRecord,
  schedule: (work) => {
    setTimeout(() => {
      work().catch(() => undefined);
    }, 0);
  },
};

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
  const verdict = await work();
  const milliseconds = Math.max(0, now() - started);

  return { verdict, milliseconds };
};

const judgeAll = async (
  ports: ShadowPorts,
  request: ShadowStart,
  config: FrozenConfig,
  question: JudgeQuestion,
  confidence: number | undefined,
  signal: AbortSignal,
): Promise<ShadowRecord['judges']> => {
  const judges = prepareJudges(request.registry, config);

  const [classifier, classifierExamples, panel, panelExamples] = await Promise.all([
    timed(ports.now, () => judges.judge('classifier', question, confidence, signal)),
    timed(ports.now, () => judges.judge('classifierExamples', question, confidence, signal)),
    timed(ports.now, () => judges.judge('panel', question, confidence, signal)),
    timed(ports.now, () => judges.judge('panelExamples', question, confidence, signal)),
  ]);

  return {
    classifier,
    classifierExamples,
    panel,
    panelExamples,
    agent: { verdict: await judges.judge('agent', question, confidence, signal), milliseconds: 0 },
  };
};

const readConfigOrReport = (
  ports: ShadowPorts,
  request: ShadowStart,
  location: ConfigLocation,
): QuestionGateShadow | undefined => {
  try {
    return ports.readConfig(location, request.ui);
  } catch (error) {
    const message = errorMessage(error);

    notifyOnce(request.ui, userConfigPath(location.agentDirectory), message, message, 'error');

    return undefined;
  }
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

      const read = readConfigOrReport(ports, request, location);

      if (read === undefined) {
        return undefined;
      }

      for (const reference of [read.classifier, ...read.panel]) {
        ports.requireModel(reference, location);
      }

      return { sharedRoot, config: read };
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
