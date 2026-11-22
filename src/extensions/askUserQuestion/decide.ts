import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { ConfigLocation } from '../../config/config.js';
import { requireAllowedModel } from '../../config/models.js';
import { readQuestionGateConfig, shadowCohort } from '../../config/questionGateModels.js';
import type { QuestionGateConfig, ShadowConfig } from '../../config/questionGateModels.js';
import { readGitUnlessMissing } from '../../git.js';
import {
  decideCall,
  decideDeadlineMilliseconds,
  decideEligibility,
  mapNonEmpty,
  writeDecisionRecord,
} from '../../questionGate/questionGate.js';
import type {
  DecisionRecord,
  DecisionRecordWriter,
  EligibleQuestion,
  JudgeVerdict,
  ShadowVariant,
} from '../../questionGate/questionGate.js';
import { writeRecord as writeRecordToFile } from '../../record.js';
import { ensureTauDirectory, findSharedRepositoryRoot } from '../../tauDirectory.js';
import type { AskedQuestion } from './dialog.js';
import { judgeQuestionOf, prepareJudges, variantModels } from './judges.js';
import type { PreparedJudges } from './judges.js';
import type { Answer } from './questionnaire.js';

export interface DecidePorts {
  now: () => number;
  findSharedRoot: (cwd: string, signal: AbortSignal) => Promise<string>;
  readConfig: (location: ConfigLocation) => QuestionGateConfig | undefined;
  requireModel: (reference: string, location: ConfigLocation) => void;
  readBranch: (cwd: string) => Promise<{ branch: string | null; head: string | null }>;
  ensureDirectory: (root: string, path: string) => Promise<string>;
  writeRecord: DecisionRecordWriter;
  prepareJudges: (
    registry: ModelRegistry,
    config: QuestionGateConfig & { shadow: ShadowConfig },
  ) => PreparedJudges;
}

interface DecideRequest {
  questions: readonly [AskedQuestion, ...AskedQuestion[]];
  sessionId: string | undefined;
  cwd: string;
  projectTrusted: boolean;
  registry: ModelRegistry;
  notify: (text: string) => void;
}

type DecideOutcome =
  | { kind: 'ask' }
  | { kind: 'decided'; answers: Answer[]; record: string; notice: string };

export interface Decider {
  tryDecide: (request: DecideRequest) => Promise<DecideOutcome> | undefined;
}

type FrozenConfig = QuestionGateConfig & { shadow: ShadowConfig };
type EligibleAskedQuestion = EligibleQuestion<AskedQuestion>;
type JudgedAskedQuestion = EligibleAskedQuestion & { verdict: JudgeVerdict };
type DecidedAskedQuestion = JudgedAskedQuestion & { confidence: number };

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
  prepareJudges,
};

const judgeAll = async (
  judges: PreparedJudges,
  variant: ShadowVariant,
  rows: readonly [EligibleAskedQuestion, ...EligibleAskedQuestion[]],
  controller: AbortController,
): Promise<[JudgedAskedQuestion, ...JudgedAskedQuestion[]]> => {
  const deadline = Promise.withResolvers<JudgeVerdict>();

  const timer = setTimeout(() => {
    controller.abort();
    deadline.resolve({ kind: 'timeout' });
  }, decideDeadlineMilliseconds);

  try {
    return await Promise.all(
      mapNonEmpty(rows, async (row) => {
        const question = judgeQuestionOf(row.question);

        const verdict = await Promise.race([
          judges.judge(variant, question, row.question.confidence, controller.signal),
          deadline.promise,
        ]);

        return { ...row, verdict };
      }),
    );
  } finally {
    clearTimeout(timer);
  }
};

const buildRecord = (
  ports: DecidePorts,
  config: FrozenConfig,
  sessionId: string,
  rows: readonly [DecidedAskedQuestion, ...DecidedAskedQuestion[]],
  branch: string | null,
  head: string | null,
): DecisionRecord => ({
  version: 1,
  kind: 'decision',
  time: ports.now(),
  sessionId,
  branch,
  head,
  cohort: shadowCohort(config),
  variant: config.shadow.variant,
  cutoff: config.shadow.cutoff,
  decisions: rows.map(({ question, recommended, confidence }) => ({
    question: judgeQuestionOf(question),
    choice: recommended.label,
    reason: recommended.description,
    confidence,
  })),
});

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
  rows: readonly [EligibleAskedQuestion, ...EligibleAskedQuestion[]],
): Promise<DecideOutcome> => {
  try {
    const controller = new AbortController();
    const sharedRoot = await ports.findSharedRoot(request.cwd, controller.signal);
    const judges = ports.prepareJudges(request.registry, config);
    const judgedRows = await judgeAll(judges, config.shadow.variant, rows, controller);

    const call = decideCall<JudgedAskedQuestion>({
      rows: judgedRows,
      cutoff: config.shadow.cutoff,
    });

    if (call.kind === 'ask') {
      return { kind: 'ask' };
    }

    const { branch, head } = await ports.readBranch(request.cwd);
    const record = buildRecord(ports, config, sessionId, call.rows, branch, head);
    const notice = noticeLines(record).join('\n');

    request.notify(notice);

    const directory = await ports.ensureDirectory(sharedRoot, 'questions');
    const path = await writeDecisionRecord(directory, record, ports.writeRecord);

    return { kind: 'decided', answers: decidedAnswers(record), record: path, notice };
  } catch {
    return { kind: 'ask' };
  }
};

export const createDecider = (overrides: Partial<DecidePorts> = {}): Decider => {
  const ports: DecidePorts = { ...defaultDecidePorts, ...overrides };

  return {
    tryDecide: (request) => {
      const eligibility = decideEligibility(request.questions);

      if (eligibility.kind !== 'eligible') {
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
        const config = ports.readConfig(location);

        if (config?.decide !== true) {
          return undefined;
        }

        for (const reference of variantModels(config.shadow.variant, config)) {
          ports.requireModel(reference, location);
        }

        return runDecision(ports, request, config, sessionId, eligibility.rows);
      } catch {
        return undefined;
      }
    },
  };
};
