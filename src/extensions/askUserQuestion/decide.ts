import { rm } from 'node:fs/promises';

import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { ConfigLocation } from '../../config/config.js';
import { requireAllowedModel } from '../../config/models.js';
import {
  decideConfig,
  readQuestionGateConfig,
  shadowCohort,
} from '../../config/questionGateModels.js';
import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import { readGitUnlessMissing } from '../../git.js';
import {
  decideCall,
  decideDeadlineMilliseconds,
  decideEligibility,
  writeDecisionRecord,
} from '../../questionGate/questionGate.js';
import type {
  DecisionRecord,
  DecisionRecordWriter,
  JudgeQuestion,
  JudgeVerdict,
  ShadowVariant,
} from '../../questionGate/questionGate.js';
import { writeRecord as writeRecordToFile } from '../../record.js';
import { ensureTauDirectory, findSharedRepositoryRoot } from '../../tauDirectory.js';
import type { DialogQuestion } from './dialog.js';
import { judgeQuestionOf, prepareJudges, variantModels } from './judges.js';
import type { PreparedJudges } from './judges.js';
import type { Answer } from './questionnaire.js';

export type DecideQuestion = DialogQuestion & {
  kind?: 'choice' | 'approval' | undefined;
  confidence?: number | undefined;
};

export interface DecidePorts {
  now: () => number;
  findSharedRoot: (cwd: string, signal: AbortSignal) => Promise<string>;
  readConfig: (location: ConfigLocation) => QuestionGateConfig | undefined;
  requireModel: (reference: string, location: ConfigLocation) => void;
  readBranch: (cwd: string) => Promise<{ branch: string | null; head: string | null }>;
  ensureDirectory: (root: string, path: string) => Promise<string>;
  writeRecord: DecisionRecordWriter;
  removeRecord: (path: string) => Promise<void>;
  prepareJudges: (
    registry: ModelRegistry,
    config: QuestionGateConfig & { shadow: ShadowConfig },
  ) => PreparedJudges;
}

interface DecideRequest {
  questions: readonly [DecideQuestion, ...DecideQuestion[]];
  sessionId: string | undefined;
  cwd: string;
  projectTrusted: boolean;
  registry: ModelRegistry;
  notify: (text: string) => void;
}

type DecideOutcome =
  | { kind: 'ask' }
  | { kind: 'decided'; answers: Answer[]; record: string; notice: string };

interface PreparedDecision {
  run: () => Promise<DecideOutcome>;
}

export interface Decider {
  prepare: (request: DecideRequest) => PreparedDecision | undefined;
}

type FrozenConfig = QuestionGateConfig & { shadow: ShadowConfig };

const readBranch = async (cwd: string): Promise<{ branch: string | null; head: string | null }> => {
  const branch = await readGitUnlessMissing(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = await readGitUnlessMissing(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);

  return { branch: branch ?? null, head: head ?? null };
};

const defaultDecidePorts: DecidePorts = {
  now: () => Date.now(),
  findSharedRoot: (cwd, signal) => findSharedRepositoryRoot(cwd, { signal }),
  readConfig: readQuestionGateConfig,
  requireModel: requireAllowedModel,
  readBranch,
  ensureDirectory: ensureTauDirectory,
  writeRecord: writeRecordToFile,
  removeRecord: (path) => rm(path),
  prepareJudges,
};

const recommendedOption = (question: DecideQuestion): { label: string; description: string } => {
  const recommended = question.options.find((option) => option.recommended === true);

  if (recommended === undefined) {
    throw new Error('An eligible question has no recommended option.');
  }

  return recommended;
};

const judgeAll = async (
  judges: PreparedJudges,
  variant: ShadowVariant,
  questions: readonly [JudgeQuestion, ...JudgeQuestion[]],
  confidences: readonly (number | undefined)[],
  controller: AbortController,
): Promise<[JudgeVerdict, ...JudgeVerdict[]]> => {
  const deadline = Promise.withResolvers<JudgeVerdict>();

  const timer = setTimeout(() => {
    controller.abort();
    deadline.resolve({ kind: 'timeout' });
  }, decideDeadlineMilliseconds);

  try {
    const verdicts = await Promise.all(
      questions.map(async (question, index) => {
        const judged = judges.judge(variant, question, confidences[index], controller.signal);

        return Promise.race([judged, deadline.promise]);
      }),
    );

    const [firstVerdict, ...remainingVerdicts] = verdicts;

    if (firstVerdict === undefined) {
      throw new Error('Expected one verdict per question.');
    }

    return [firstVerdict, ...remainingVerdicts];
  } finally {
    clearTimeout(timer);
  }
};

const buildRecord = (
  ports: DecidePorts,
  request: DecideRequest,
  config: FrozenConfig,
  sessionId: string,
  questions: readonly [JudgeQuestion, ...JudgeQuestion[]],
  confidences: readonly number[],
  branch: string | null,
  head: string | null,
): DecisionRecord => {
  const decisions = request.questions.map((source, index) => {
    const question = questions[index];
    const confidence = confidences[index];

    if (question === undefined || confidence === undefined) {
      throw new Error('Expected one decision per question.');
    }

    const recommended = recommendedOption(source);

    return {
      question,
      choice: recommended.label,
      reason: recommended.description,
      confidence,
    };
  });

  return {
    version: 1,
    kind: 'decision',
    time: ports.now(),
    sessionId,
    branch,
    head,
    cohort: shadowCohort(config),
    variant: config.shadow.variant,
    cutoff: config.shadow.cutoff,
    decisions,
  };
};

const noticeLines = (record: DecisionRecord): string[] =>
  record.decisions.map((decision) => `Decided: ${decision.choice}, because ${decision.reason}`);

const decidedAnswers = (record: DecisionRecord): Answer[] =>
  record.decisions.map((decision) => ({
    question: decision.question.question,
    selected: [decision.choice],
    typed: false,
  }));

const runDecision = async (
  ports: DecidePorts,
  request: DecideRequest,
  config: FrozenConfig,
  sessionId: string,
): Promise<DecideOutcome> => {
  try {
    const controller = new AbortController();
    const sharedRoot = await ports.findSharedRoot(request.cwd, controller.signal);
    const [firstQuestion, ...remainingQuestions] = request.questions;

    const questions: [JudgeQuestion, ...JudgeQuestion[]] = [
      judgeQuestionOf(firstQuestion),
      ...remainingQuestions.map(judgeQuestionOf),
    ];

    const confidences = request.questions.map((question) => question.confidence);
    const judges = ports.prepareJudges(request.registry, config);

    const verdicts = await judgeAll(
      judges,
      config.shadow.variant,
      questions,
      confidences,
      controller,
    );

    const call = decideCall({ verdicts, cutoff: config.shadow.cutoff });

    if (call.kind === 'ask') {
      return { kind: 'ask' };
    }

    const { branch, head } = await ports.readBranch(request.cwd);
    const directory = await ports.ensureDirectory(sharedRoot, 'questions');

    const record = buildRecord(
      ports,
      request,
      config,
      sessionId,
      questions,
      call.confidences,
      branch,
      head,
    );

    const path = await writeDecisionRecord(directory, record, ports.writeRecord);
    const notice = noticeLines(record).join('\n');

    try {
      request.notify(notice);
    } catch {
      await ports.removeRecord(path).catch(() => undefined);

      return { kind: 'ask' };
    }

    return { kind: 'decided', answers: decidedAnswers(record), record: path, notice };
  } catch {
    return { kind: 'ask' };
  }
};

export const createDecider = (overrides: Partial<DecidePorts> = {}): Decider => {
  const ports: DecidePorts = { ...defaultDecidePorts, ...overrides };

  return {
    prepare: (request) => {
      if (decideEligibility(request.questions).kind !== 'eligible') {
        return undefined;
      }

      const { sessionId } = request;

      if (sessionId === undefined) {
        return undefined;
      }

      const location: ConfigLocation = {
        cwd: request.cwd,
        agentDirectory: getAgentDir(),
        projectTrusted: request.projectTrusted,
      };

      try {
        const config = decideConfig(ports.readConfig(location));

        if (config === undefined) {
          return undefined;
        }

        for (const reference of variantModels(config.shadow.variant, config)) {
          ports.requireModel(reference, location);
        }

        return { run: () => runDecision(ports, request, config, sessionId) };
      } catch {
        return undefined;
      }
    },
  };
};
