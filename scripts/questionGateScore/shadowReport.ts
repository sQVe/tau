import { questionGateDecision } from '../../src/questionGate/decision.ts';
import type { ShadowRecord, ShadowVariant } from '../../src/questionGate/questionGate.ts';

export interface ShadowReportInput {
  records: readonly ShadowRecord[];
  cohort: string;
  variant: ShadowVariant;
  cutoff: number;
}

export interface ShadowReport {
  cohort: string;
  variant: ShadowVariant;
  cutoff: number;
  sampled: number;
  predictions: number;
  predictionSessions: number;
  agreement: number | undefined;
  lowerBound: number | undefined;
  potentialSaves: number;
  potentialSaveShare: number | undefined;
  actualSaves: number;
  meanMilliseconds: number | undefined;
}

interface SessionScore {
  predictions: number;
  hits: number;
}

const confidenceLevel = 20;
const percentScale = 100;

const share = (part: number, total: number): number | undefined =>
  total === 0 ? undefined : part / total;

const recommendedLabel = (record: ShadowRecord): string | undefined =>
  record.question.options.find((option) => option.recommended)?.label;

const isHit = (record: ShadowRecord): boolean => {
  const { answer } = record;

  if (answer.kind !== 'answered' || answer.typed || answer.selected.length !== 1) {
    return false;
  }

  return answer.selected[0] === recommendedLabel(record);
};

const isPredictedDecision = (
  record: ShadowRecord,
  variant: ShadowVariant,
  cutoff: number,
): boolean =>
  questionGateDecision({ verdict: record.judges[variant].verdict, cutoff }).decision === 'decide';

const sessionScores = (
  records: readonly ShadowRecord[],
  variant: ShadowVariant,
  cutoff: number,
): Map<string, SessionScore> => {
  const scores = new Map<string, SessionScore>();

  for (const record of records) {
    if (!isPredictedDecision(record, variant, cutoff)) {
      continue;
    }

    const known = scores.get(record.sessionId) ?? { predictions: 0, hits: 0 };

    known.predictions += 1;

    if (isHit(record)) {
      known.hits += 1;
    }

    scores.set(record.sessionId, known);
  }

  return scores;
};

const weightedSquareSum = (scores: readonly SessionScore[], predictions: number): number =>
  scores.reduce((total, score) => total + (score.predictions / predictions) ** 2, 0);

const sessionLowerBound = (
  scores: readonly SessionScore[],
  predictions: number,
  agreement: number,
): number => {
  const squaredWeights = weightedSquareSum(scores, predictions);
  const spread = Math.sqrt((Math.log(confidenceLevel) * squaredWeights) / 2);

  return Math.max(0, agreement - spread);
};

const meanMilliseconds = (
  records: readonly ShadowRecord[],
  variant: ShadowVariant,
): number | undefined => {
  if (records.length === 0) {
    return undefined;
  }

  const total = records.reduce((sum, record) => sum + record.judges[variant].milliseconds, 0);

  return total / records.length;
};

const percent = (value: number | undefined): string =>
  value === undefined ? 'n/a' : `${(value * percentScale).toFixed(1)}%`;

const milliseconds = (value: number | undefined): string =>
  value === undefined ? 'n/a' : `${value.toFixed(1)} ms`;

export const shadowReport = (input: ShadowReportInput): ShadowReport => {
  const matching = input.records.filter((record) => record.cohort === input.cohort);
  const scores = sessionScores(matching, input.variant, input.cutoff);
  const sessionValues = [...scores.values()];
  const predictions = sessionValues.reduce((total, score) => total + score.predictions, 0);
  const hits = sessionValues.reduce((total, score) => total + score.hits, 0);
  const agreement = share(hits, predictions);

  const potentialSaves = matching.filter((record) =>
    isPredictedDecision(record, input.variant, input.cutoff),
  ).length;

  return {
    cohort: input.cohort,
    variant: input.variant,
    cutoff: input.cutoff,
    sampled: matching.length,
    predictions,
    predictionSessions: scores.size,
    agreement,
    lowerBound:
      agreement === undefined
        ? undefined
        : sessionLowerBound(sessionValues, predictions, agreement),
    potentialSaves,
    potentialSaveShare: share(potentialSaves, matching.length),
    actualSaves: 0,
    meanMilliseconds: meanMilliseconds(matching, input.variant),
  };
};

export const formatShadowReport = (report: ShadowReport): string =>
  [
    `Shadow report for cohort ${report.cohort}`,
    `Variant: ${report.variant} at cutoff ${report.cutoff.toFixed(2)}`,
    `Sampled dialogs: ${report.sampled}`,
    `Predictions: ${report.predictions} from ${report.predictionSessions} sessions`,
    `Agreement: ${percent(report.agreement)}`,
    `95% lower bound: ${percent(report.lowerBound)}`,
    `Potential saves: ${report.potentialSaves} (${percent(report.potentialSaveShare)} of sampled dialogs)`,
    `Actual saves: ${report.actualSaves}`,
    `Judge time: ${milliseconds(report.meanMilliseconds)} mean`,
  ].join('\n') + '\n';
