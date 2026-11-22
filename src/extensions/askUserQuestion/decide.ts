import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
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
  readConfig: (location: ConfigLocation, ui: ConfigWarnings) => QuestionGateConfig | undefined;
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
  signal: AbortSignal | undefined;
  ui: ConfigWarnings;
}

export type DecideOutcome =
  | { kind: 'ask' }
  | { kind: 'cancelled' }
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

const isCancelled = (request: DecideRequest): boolean => request.signal?.aborted === true;

const judgeAll = async (
  judges: PreparedJudges,
  variant: ShadowVariant,
  rows: readonly [EligibleAskedQuestion, ...EligibleAskedQuestion[]],
  controller: AbortController,
  signal: AbortSignal | undefined,
): Promise<[JudgedAskedQuestion, ...JudgedAskedQuestion[]]> => {
  const deadline = Promise.withResolvers<JudgeVerdict>();

  const cancel = () => {
    controller.abort();
    deadline.resolve({ kind: 'timeout' });
  };

  const timer = setTimeout(cancel, decideDeadlineMilliseconds);

  signal?.addEventListener('abort', cancel, { once: true });

  try {
    if (signal?.aborted === true) {
      cancel();
    }

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
    signal?.removeEventListener('abort', cancel);
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

const saveDecision = async (
  ports: DecidePorts,
  request: DecideRequest,
  sharedRoot: string,
  record: DecisionRecord,
  notice: string,
): Promise<DecideOutcome> => {
  try {
    const directory = await ports.ensureDirectory(sharedRoot, 'questions');
    const path = await writeDecisionRecord(directory, record, ports.writeRecord);

    return { kind: 'decided', answers: decidedAnswers(record), record: path, notice };
  } catch {
    return isCancelled(request) ? { kind: 'cancelled' } : { kind: 'ask' };
  }
};

const runDecision = async (
  ports: DecidePorts,
  request: DecideRequest,
  config: FrozenConfig,
  sessionId: string,
  rows: readonly [EligibleAskedQuestion, ...EligibleAskedQuestion[]],
): Promise<DecideOutcome> => {
  const controller = new AbortController();

  const cancel = () => {
    controller.abort();
  };

  request.signal?.addEventListener('abort', cancel, { once: true });

  try {
    if (isCancelled(request)) {
      return { kind: 'cancelled' };
    }

    const sharedRoot = await ports.findSharedRoot(request.cwd, controller.signal);
    const judges = ports.prepareJudges(request.registry, config);

    const judgedRows = await judgeAll(
      judges,
      config.shadow.variant,
      rows,
      controller,
      request.signal,
    );

    if (isCancelled(request)) {
      return { kind: 'cancelled' };
    }

    const call = decideCall<JudgedAskedQuestion>({
      rows: judgedRows,
      cutoff: config.shadow.cutoff,
    });

    if (call.kind === 'ask') {
      return { kind: 'ask' };
    }

    if (isCancelled(request)) {
      return { kind: 'cancelled' };
    }

    const { branch, head } = await ports.readBranch(request.cwd);
    const record = buildRecord(ports, config, sessionId, call.rows, branch, head);
    const notice = noticeLines(record).join('\n');

    if (isCancelled(request)) {
      return { kind: 'cancelled' };
    }

    request.ui.notify(notice, 'info');

    return await saveDecision(ports, request, sharedRoot, record, notice);
  } catch {
    return isCancelled(request) ? { kind: 'cancelled' } : { kind: 'ask' };
  } finally {
    request.signal?.removeEventListener('abort', cancel);
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
        const config = ports.readConfig(location, request.ui);

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
