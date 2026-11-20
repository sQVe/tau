import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { contentText, retryAssistantCall } from '@earendil-works/pi-ai';
import type { RetryPolicy } from '@earendil-works/pi-ai';
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { classifyChoice } from '../src/classifier/classifier.ts';
import { userConfigPath } from '../src/config/config.ts';
import { parseModelReference, requireAllowedModel } from '../src/config/models.ts';
import { readQuestionGateModels } from '../src/config/questionGateModels.ts';
import type { QuestionGateModels } from '../src/config/questionGateModels.ts';
import { findSessionFiles } from '../src/improvement/improvement.ts';
import { judgeWithClassifier, judgeWithPanel } from '../src/questionGate/questionGate.ts';
import type {
  ClassifyQuestion,
  JudgeQuestion,
  JudgeVerdict,
  PanelMember,
  PastAnswer,
} from '../src/questionGate/questionGate.ts';
import { questionLogReader } from './questionGateScore/questionGateScoreLog.ts';
import type { SessionLog } from './questionGateScore/questionGateScoreLog.ts';
import { prepareScoreQuestions } from './questionGateScore/questionGateScorePrepare.ts';
import type {
  PreparedQuestion,
  ScoreSelection,
} from './questionGateScore/questionGateScorePrepare.ts';
import {
  formatPanelMemberErrors,
  formatScoreReport,
  panelMemberErrorCounts,
  scoreReport,
} from './questionGateScore/questionGateScoreReport.ts';
import type {
  JudgeVariant,
  PanelMemberError,
  ScoreItem,
} from './questionGateScore/questionGateScoreReport.ts';
import { parseTime, readInTurn } from './tokenUsage.ts';

interface Judges {
  classify: ClassifyQuestion;
  members: [PanelMember, PanelMember, PanelMember];
}

export interface PanelMemberDiagnostics {
  retry: RetryPolicy;
  recordError: (message: string) => void;
}

const usage =
  'Usage: node scripts/questionGateScore.ts [--since <time>] [--until <time>] [--limit 500] [--holdout 0.3]';

const judgeChunkSize = 4;
const progressStep = 25;

export const parseScoreArguments = (argv: string[], now: number): ScoreSelection => {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      limit: { type: 'string', default: '500' },
      holdout: { type: 'string', default: '0.3' },
    },
  });

  const since = values.since === undefined ? undefined : parseTime(values.since, now);
  const until = values.until === undefined ? undefined : parseTime(values.until, now);
  const limit = Number(values.limit);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`--limit must be a positive integer, not "${values.limit}". ${usage}`);
  }

  const holdout = Number(values.holdout);

  if (!(holdout > 0 && holdout < 1)) {
    throw new TypeError(`--holdout must be above 0 and below 1, not "${values.holdout}". ${usage}`);
  }

  return { since, until, limit, holdout };
};

export const panelMember = (
  registry: ModelRegistry,
  reference: string,
  diagnostics: PanelMemberDiagnostics,
): PanelMember => {
  return async (prompt, signal) => {
    const parsed = parseModelReference(reference);

    if (parsed === undefined) {
      return { kind: 'unavailable' };
    }

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
    const model = registry.find(parsed.provider, parsed.id);

    if (model === undefined) {
      return { kind: 'unavailable' };
    }

    try {
      const reply = await retryAssistantCall(
        () =>
          registry.complete(
            model,
            {
              systemPrompt: prompt.system,
              messages: [{ role: 'user', content: prompt.user, timestamp: Date.now() }],
            },
            { signal },
          ),
        diagnostics.retry,
        signal,
      );

      if (reply.stopReason === 'stop') {
        return { kind: 'replied', text: contentText(reply.content).trim() };
      }

      if (reply.stopReason !== 'aborted') {
        diagnostics.recordError(reply.errorMessage ?? reply.stopReason);
      }

      return { kind: 'error' };
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);

        diagnostics.recordError(message);
      }

      return { kind: 'error' };
    }
  };
};

export const writePanelMemberErrors = (
  errors: readonly PanelMemberError[],
  write: (line: string) => void,
): void => {
  for (const line of formatPanelMemberErrors(panelMemberErrorCounts(errors))) {
    write(line);
  }
};

const judgeQuestion = async (
  judges: Judges,
  question: JudgeQuestion,
  examples: readonly PastAnswer[],
): Promise<Record<JudgeVariant, JudgeVerdict>> => {
  const [classifier, classifierExamples, panel, panelExamples] = await Promise.all([
    judgeWithClassifier(judges.classify, question, [], undefined),
    judgeWithClassifier(judges.classify, question, examples, undefined),
    judgeWithPanel(judges.members, question, [], undefined),
    judgeWithPanel(judges.members, question, examples, undefined),
  ] as const);

  return { classifier, classifierExamples, panel, panelExamples };
};

const judgeItem = async (judges: Judges, prepared: PreparedQuestion): Promise<ScoreItem> => {
  const verdicts = await judgeQuestion(judges, prepared.question, prepared.examples);

  return {
    session: prepared.session,
    split: prepared.split,
    outcome: prepared.outcome,
    verdicts,
  };
};

const judgeAll = async (
  judges: Judges,
  questions: readonly PreparedQuestion[],
): Promise<ScoreItem[]> => {
  const items: ScoreItem[] = [];
  let nextReport = progressStep;

  for (let start = 0; start < questions.length; start += judgeChunkSize) {
    const chunk = questions.slice(start, start + judgeChunkSize);
    // oxlint-disable-next-line no-await-in-loop -- Each chunk reports progress before the next starts.
    const judged = await Promise.all(chunk.map((prepared) => judgeItem(judges, prepared)));

    items.push(...judged);

    const reachedReport = items.length >= nextReport;
    const reachedEnd = items.length === questions.length;

    if (reachedReport || reachedEnd) {
      process.stderr.write(`Judged ${items.length} of ${questions.length} questions.\n`);
      nextReport = (Math.floor(items.length / progressStep) + 1) * progressStep;
    }
  }

  return items;
};

const readSession = async (path: string): Promise<SessionLog | undefined> => {
  try {
    return { path, text: await readFile(path, 'utf8') };
  } catch {
    return undefined;
  }
};

const buildJudges = (
  registry: ModelRegistry,
  models: QuestionGateModels,
  retry: RetryPolicy,
  recordError: (model: string, message: string) => void,
): Judges => {
  const classify: ClassifyQuestion = (state, question, signal) =>
    classifyChoice({ modelRegistry: registry }, models.classifier, state, question, signal);

  const [first, second, third] = models.panel;

  const memberFor = (reference: string): PanelMember =>
    panelMember(registry, reference, {
      retry,
      recordError: (message) => {
        recordError(reference, message);
      },
    });

  const members: [PanelMember, PanelMember, PanelMember] = [
    memberFor(first),
    memberFor(second),
    memberFor(third),
  ];

  return { classify, members };
};

const main = async () => {
  const args = parseScoreArguments(process.argv.slice(2), Date.now());
  const agentDirectory = getAgentDir();
  const location = { cwd: process.cwd(), agentDirectory, projectTrusted: false };
  const models = readQuestionGateModels(location);

  if (models === undefined) {
    throw new Error(
      `Set questionGate in ${userConfigPath(agentDirectory)} to name the classifier and the three panel models.`,
    );
  }

  for (const reference of [models.classifier, ...models.panel]) {
    requireAllowedModel(reference, location);
  }

  const sessionFiles = await findSessionFiles(agentDirectory);
  const reader = questionLogReader();

  await readInTurn(sessionFiles.managerSessions, async (path) => {
    const session = await readSession(path);

    if (session !== undefined) {
      reader.add(session);
    }
  });

  const log = reader.finish();
  const prepared = prepareScoreQuestions(log.questions, args);

  const runtime = await ModelRuntime.create({});
  const registry = new ModelRegistry(runtime);

  const retry = SettingsManager.create(process.cwd(), agentDirectory, {
    projectTrusted: false,
  }).getRetrySettings();

  const panelErrors: PanelMemberError[] = [];

  const judges = buildJudges(registry, models, retry, (model, message) =>
    panelErrors.push({ model, message }),
  );

  const items = await judgeAll(judges, prepared);

  writePanelMemberErrors(panelErrors, (line) => {
    process.stderr.write(`${line}\n`);
  });

  process.stdout.write(formatScoreReport(scoreReport({ models, skipped: log.skipped, items })));
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
