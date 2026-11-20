import { createHash } from 'node:crypto';
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
import { exampleCount, pastExamples } from '../src/questionGate/examples.ts';
import { judgeWithClassifier, judgeWithPanel } from '../src/questionGate/questionGate.ts';
import type {
  ClassifyQuestion,
  JudgeVerdict,
  PanelMember,
  PastAnswer,
} from '../src/questionGate/questionGate.ts';
import { questionLogReader } from './questionGateScore/questionGateScoreLog.ts';
import type { LoggedQuestion, SessionLog } from './questionGateScore/questionGateScoreLog.ts';
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

export interface ScoreArguments {
  since: number | undefined;
  until: number | undefined;
  limit: number;
  holdout: number;
}

interface ScoredQuestion {
  question: LoggedQuestion;
  split: 'tuning' | 'holdout';
}

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
const hashHexDigits = 8;
const hashBits = 32;
const hashSpace = 2 ** hashBits;

export const parseScoreArguments = (argv: string[], now: number): ScoreArguments => {
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

const inWindow = (time: number, args: ScoreArguments): boolean => {
  const afterStart = args.since === undefined || time >= args.since;
  const beforeEnd = args.until === undefined || time < args.until;

  return afterStart && beforeEnd;
};

const lastTime = (questions: readonly LoggedQuestion[]): number => questions.at(-1)?.time ?? 0;

// A live gate would have every question in a session it reads, so the limit takes whole sessions.
const selectQuestions = (questions: readonly LoggedQuestion[], limit: number): LoggedQuestion[] => {
  const groups = new Map<string, LoggedQuestion[]>();

  for (const question of questions) {
    const group = groups.get(question.session) ?? [];

    group.push(question);
    groups.set(question.session, group);
  }

  const newestFirst = [...groups.values()].toSorted(
    (left, right) => lastTime(right) - lastTime(left),
  );

  const selected: LoggedQuestion[] = [];

  for (const group of newestFirst) {
    if (selected.length >= limit) {
      break;
    }

    selected.push(...group);
  }

  return selected;
};

const isHeldOut = (session: string, holdout: number): boolean => {
  const digest = createHash('sha256').update(session).digest('hex').slice(0, hashHexDigits);
  const fraction = Number.parseInt(digest, 16) / hashSpace;

  return fraction < holdout;
};

const answersByCallTime = (questions: readonly LoggedQuestion[]): PastAnswer[] =>
  questions.map((question) => ({
    time: question.callTime,
    question: question.question,
    outcome: question.outcome,
  }));

const judgeQuestion = async (
  judges: Judges,
  question: LoggedQuestion,
  examples: readonly PastAnswer[],
): Promise<Record<JudgeVariant, JudgeVerdict>> => {
  const [classifier, classifierExamples, panel, panelExamples] = await Promise.all([
    judgeWithClassifier(judges.classify, question.question, [], undefined),
    judgeWithClassifier(judges.classify, question.question, examples, undefined),
    judgeWithPanel(judges.members, question.question, [], undefined),
    judgeWithPanel(judges.members, question.question, examples, undefined),
  ] as const);

  return { classifier, classifierExamples, panel, panelExamples };
};

const judgeItem = async (
  judges: Judges,
  scored: ScoredQuestion,
  answers: readonly PastAnswer[],
): Promise<ScoreItem> => {
  const examples = pastExamples(answers, scored.question.callTime, exampleCount);
  const verdicts = await judgeQuestion(judges, scored.question, examples);

  return {
    session: scored.question.session,
    split: scored.split,
    outcome: scored.question.outcome,
    verdicts,
  };
};

const judgeAll = async (
  judges: Judges,
  questions: readonly ScoredQuestion[],
  answers: readonly PastAnswer[],
): Promise<ScoreItem[]> => {
  const items: ScoreItem[] = [];
  let nextReport = progressStep;

  for (let start = 0; start < questions.length; start += judgeChunkSize) {
    const chunk = questions.slice(start, start + judgeChunkSize);
    // oxlint-disable-next-line no-await-in-loop -- Each chunk reports progress before the next starts.
    const judged = await Promise.all(chunk.map((scored) => judgeItem(judges, scored, answers)));

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

  const inWindowQuestions = log.questions.filter((question) => inWindow(question.time, args));
  const selected = selectQuestions(inWindowQuestions, args.limit);

  const scored = selected.map((question) => ({
    question,
    split: isHeldOut(question.session, args.holdout) ? ('holdout' as const) : ('tuning' as const),
  }));

  const runtime = await ModelRuntime.create({});
  const registry = new ModelRegistry(runtime);

  const retry = SettingsManager.create(process.cwd(), agentDirectory, {
    projectTrusted: false,
  }).getRetrySettings();

  const panelErrors: PanelMemberError[] = [];

  const judges = buildJudges(registry, models, retry, (model, message) =>
    panelErrors.push({ model, message }),
  );

  const items = await judgeAll(judges, scored, answersByCallTime(log.questions));

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
