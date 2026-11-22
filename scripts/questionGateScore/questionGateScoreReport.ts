import type { QuestionGateModels } from '../../src/config/questionGateModels.ts';
import { questionGateDecision } from '../../src/questionGate/decision/decision.ts';
import type { JudgeVerdict, PastOutcome } from '../../src/questionGate/questionGate.ts';
import type { SkippedQuestions } from './questionGateScoreLog.ts';
import { sessionSummary } from './sessionLowerBound.ts';

export type JudgeVariant = 'classifier' | 'classifierExamples' | 'panel' | 'panelExamples';

export interface ScoreItem {
  session: string;
  split: 'tuning' | 'holdout';
  outcome: PastOutcome;
  verdicts: Record<JudgeVariant, JudgeVerdict>;
}

export interface ScoreInput {
  models: QuestionGateModels;
  skipped: SkippedQuestions;
  items: readonly ScoreItem[];
}

interface CutoffScore {
  cutoff: number;
  decided: number;
  decideShare: number;
  agreement: number;
  lowerBound: number;
}

interface HeldOutScore extends CutoffScore {
  sessions: number;
  sessionLowerBound: number;
  meetsBar: boolean;
}

interface VerdictCounts {
  answered: number;
  timeout: number;
  error: number;
  unavailable: number;
}

export interface VariantScore {
  variant: JudgeVariant;
  cutoffs: CutoffScore[];
  cutoff: number | undefined;
  heldOut: HeldOutScore | undefined;
  verdicts: VerdictCounts;
}

export interface ScoreReport {
  models: QuestionGateModels;
  sessions: { tuning: number; holdout: number };
  questions: { tuning: number; holdout: number };
  skipped: SkippedQuestions;
  variants: VariantScore[];
}

export interface PanelMemberError {
  model: string;
  message: string;
}

export interface PanelMemberErrorCount {
  model: string;
  errors: number;
  firstMessage: string;
}

const judgeVariants: readonly JudgeVariant[] = [
  'classifier',
  'classifierExamples',
  'panel',
  'panelExamples',
];

const cutoffCount = 11;
const firstCutoffPercent = 50;
const cutoffStepPercent = 5;
const percentScale = 100;
const tenthsPerPercent = 10;
const lowerBoundTenthsScale = percentScale * tenthsPerPercent;

const zScore = 1.96;
const varianceScale = 4;
const bar = 0.95;
const minimumDecided = 20;

export const scoreCutoffs: readonly number[] = Array.from(
  { length: cutoffCount },
  (_, index) => (firstCutoffPercent + index * cutoffStepPercent) / percentScale,
);

export const wilsonLowerBound = (successes: number, total: number): number => {
  if (total === 0) {
    return 0;
  }

  const proportion = successes / total;
  const zSquared = zScore * zScore;
  const denominator = 1 + zSquared / total;
  const centre = proportion + zSquared / (2 * total);

  const spread =
    zScore *
    Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (varianceScale * total * total));

  return Math.max(0, (centre - spread) / denominator);
};

const share = (part: number, total: number): number => (total === 0 ? 0 : part / total);

const isDecided = (verdict: JudgeVerdict, cutoff: number): boolean =>
  questionGateDecision({ verdict, cutoff }).decision === 'decide';

const isHit = (item: ScoreItem): boolean => item.outcome.kind === 'recommended';

const decidedItems = (
  items: readonly ScoreItem[],
  variant: JudgeVariant,
  cutoff: number,
): ScoreItem[] => items.filter((item) => isDecided(item.verdicts[variant], cutoff));

const scoreFromTotals = (
  total: number,
  cutoff: number,
  decided: number,
  hits: number,
): CutoffScore => ({
  cutoff,
  decided,
  decideShare: share(decided, total),
  agreement: share(hits, decided),
  lowerBound: wilsonLowerBound(hits, decided),
});

const cutoffScore = (
  items: readonly ScoreItem[],
  variant: JudgeVariant,
  cutoff: number,
): CutoffScore => {
  const decided = decidedItems(items, variant, cutoff);
  const hits = decided.filter(isHit).length;

  return scoreFromTotals(items.length, cutoff, decided.length, hits);
};

const meetsCutoffBar = (score: CutoffScore): boolean =>
  score.decided >= minimumDecided && score.agreement >= bar;

const heldOutScore = (
  items: readonly ScoreItem[],
  variant: JudgeVariant,
  cutoff: number,
): HeldOutScore => {
  const decided = decidedItems(items, variant, cutoff);

  const summary = sessionSummary(
    decided.map((item) => ({ session: item.session, hit: isHit(item) })),
  );

  const score = scoreFromTotals(items.length, cutoff, summary.decided, summary.hits);

  return {
    ...score,
    sessions: summary.sessions,
    sessionLowerBound: summary.lowerBound,
    meetsBar: score.lowerBound >= bar && summary.lowerBound >= bar,
  };
};

const verdictCounts = (items: readonly ScoreItem[], variant: JudgeVariant): VerdictCounts => {
  const counts: VerdictCounts = { answered: 0, timeout: 0, error: 0, unavailable: 0 };

  for (const item of items) {
    counts[item.verdicts[variant].kind] += 1;
  }

  return counts;
};

const variantScore = (
  variant: JudgeVariant,
  tuning: readonly ScoreItem[],
  holdout: readonly ScoreItem[],
): VariantScore => {
  const cutoffs = scoreCutoffs.map((cutoff) => cutoffScore(tuning, variant, cutoff));
  const chosen = cutoffs.find(meetsCutoffBar);
  const heldOut = chosen === undefined ? undefined : heldOutScore(holdout, variant, chosen.cutoff);
  const verdicts = verdictCounts([...tuning, ...holdout], variant);

  return { variant, cutoffs, cutoff: chosen?.cutoff, heldOut, verdicts };
};

const sessionCount = (items: readonly ScoreItem[]): number =>
  new Set(items.map((item) => item.session)).size;

export const scoreReport = (input: ScoreInput): ScoreReport => {
  const tuning = input.items.filter((item) => item.split === 'tuning');
  const holdout = input.items.filter((item) => item.split === 'holdout');

  return {
    models: input.models,
    sessions: { tuning: sessionCount(tuning), holdout: sessionCount(holdout) },
    questions: { tuning: tuning.length, holdout: holdout.length },
    skipped: input.skipped,
    variants: judgeVariants.map((variant) => variantScore(variant, tuning, holdout)),
  };
};

export const lowerBoundPercent = (value: number): number =>
  Math.floor(value * lowerBoundTenthsScale) / tenthsPerPercent;

const formatPercent = (value: number): string => `${(value * percentScale).toFixed(1)}%`;

const formatLowerBound = (value: number): string => `${lowerBoundPercent(value).toFixed(1)}%`;

const formatCutoff = (cutoff: number): string => cutoff.toFixed(2);

const table = (headings: readonly string[], rows: readonly string[][]): string => {
  const all = [headings, ...rows];

  const widths = headings.map((_, column) =>
    Math.max(...all.map((row) => row[column]?.length ?? 0)),
  );

  const line = (row: readonly string[], align: 'start' | 'end'): string =>
    row
      .map((cell, column) => {
        const width = widths[column] ?? 0;

        return align === 'start' ? cell.padEnd(width) : cell.padStart(width);
      })
      .join('  ')
      .trimEnd();

  return [line(headings, 'start'), ...rows.map((row) => line(row, 'end'))].join('\n');
};

const cutoffTable = (cutoffs: readonly CutoffScore[]): string =>
  table(
    ['cutoff', 'decided', 'decide share', 'agreement', 'lower bound'],
    cutoffs.map((score) => [
      formatCutoff(score.cutoff),
      String(score.decided),
      formatPercent(score.decideShare),
      formatPercent(score.agreement),
      formatPercent(score.lowerBound),
    ]),
  );

const cutoffLine = (score: VariantScore): string =>
  score.cutoff === undefined
    ? 'Cutoff for 95%: none (no cutoff has 20 decided tuning questions with agreement at least 95%)'
    : `Cutoff for 95%: ${formatCutoff(score.cutoff)}`;

const heldOutLine = (score: VariantScore): string[] => {
  const heldOut = score.heldOut;

  if (heldOut === undefined) {
    return [];
  }

  const barResult = heldOut.meetsBar ? 'meets the 95% bar' : 'misses the 95% bar';

  const line = [
    `Held out at ${formatCutoff(heldOut.cutoff)}: ${heldOut.decided} decided,`,
    `decide share ${formatPercent(heldOut.decideShare)},`,
    `agreement ${formatPercent(heldOut.agreement)},`,
    `question lower bound ${formatLowerBound(heldOut.lowerBound)},`,
    `session lower bound ${formatLowerBound(heldOut.sessionLowerBound)},`,
    `contributing sessions ${heldOut.sessions}:`,
    barResult,
  ].join(' ');

  return [line];
};

const verdictLine = (counts: VerdictCounts): string =>
  `Verdicts: ${counts.answered} answered, ${counts.timeout} timeout, ${counts.error} error, ${counts.unavailable} unavailable`;

const skipLabels: readonly (readonly [keyof SkippedQuestions, string])[] = [
  ['malformedLines', 'malformed lines'],
  ['copiedEntries', 'copied entries'],
  ['declinedCalls', 'declined calls'],
  ['failedCalls', 'failed calls'],
  ['unansweredCalls', 'unanswered calls'],
  ['unmatchedResults', 'unmatched results'],
  ['ambiguousEntries', 'ambiguous entries'],
  ['malformedAnswers', 'malformed answers'],
  ['noRecommendation', 'no recommendation'],
  ['multiSelect', 'multi-select'],
  ['preview', 'preview'],
];

const skippedLine = (skipped: SkippedQuestions): string =>
  `Skipped: ${skipLabels.map(([key, label]) => `${skipped[key]} ${label}`).join(', ')}`;

const modelsLine = (models: QuestionGateModels): string =>
  `Models: classifier ${models.classifier}; panel ${models.panel.join(', ')}`;

const explorationLine =
  'Exploration only: past logs lack question kind and full context. This sets no launch cutoff.';

const panelMessageLimit = 200;

const shortMessage = (message: string): string =>
  message.length <= panelMessageLimit ? message : `${message.slice(0, panelMessageLimit)}...`;

export const panelMemberErrorCounts = (
  errors: readonly PanelMemberError[],
): PanelMemberErrorCount[] => {
  const counts = new Map<string, PanelMemberErrorCount>();

  for (const { model, message } of errors) {
    const known = counts.get(model);

    if (known === undefined) {
      counts.set(model, { model, errors: 1, firstMessage: shortMessage(message) });
    } else {
      known.errors += 1;
    }
  }

  return [...counts.values()];
};

const errorWord = (count: number): string => (count === 1 ? 'error' : 'errors');

export const formatPanelMemberErrors = (counts: readonly PanelMemberErrorCount[]): string[] => {
  if (counts.length === 0) {
    return ['Panel member errors: none'];
  }

  return counts.map(
    (count) =>
      `Panel member errors: ${count.model}: ${count.errors} ${errorWord(count.errors)}, first: ${count.firstMessage}`,
  );
};

const limitationLine =
  'Older logs cannot tell a click from typed text that equals an exact option label, so a typed miss can count as a pick.';

export const formatScoreReport = (report: ScoreReport): string => {
  const sections = report.variants.flatMap((score) => [
    score.variant,
    cutoffTable(score.cutoffs),
    cutoffLine(score),
    ...heldOutLine(score),
    verdictLine(score.verdicts),
    '',
  ]);

  return [
    explorationLine,
    limitationLine,
    `Sessions: ${report.sessions.tuning} tuning, ${report.sessions.holdout} held out`,
    `Questions: ${report.questions.tuning} tuning, ${report.questions.holdout} held out`,
    skippedLine(report.skipped),
    modelsLine(report.models),
    '',
    ...sections,
  ].join('\n');
};
