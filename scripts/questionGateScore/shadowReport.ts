import { questionGateDecision } from '../../src/questionGate/decision/decision.ts';
import type { ShadowRecord, ShadowVariant } from '../../src/questionGate/questionGate.ts';
import { sessionSummary } from './sessionLowerBound.ts';
import type { SessionObservation } from './sessionLowerBound.ts';

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

const sessionObservations = (
  records: readonly ShadowRecord[],
  variant: ShadowVariant,
  cutoff: number,
): SessionObservation[] => {
  const observations: SessionObservation[] = [];

  for (const record of records) {
    if (!isPredictedDecision(record, variant, cutoff)) {
      continue;
    }

    observations.push({ session: record.sessionId, hit: isHit(record) });
  }

  return observations;
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
  const summary = sessionSummary(sessionObservations(matching, input.variant, input.cutoff));
  const predictions = summary.decided;
  const agreement = share(summary.hits, predictions);
  const potentialSaves = predictions;

  return {
    cohort: input.cohort,
    variant: input.variant,
    cutoff: input.cutoff,
    sampled: matching.length,
    predictions,
    predictionSessions: summary.sessions,
    agreement,
    lowerBound: agreement === undefined ? undefined : summary.lowerBound,
    potentialSaves,
    potentialSaveShare: share(potentialSaves, matching.length),
    actualSaves: 0,
    meanMilliseconds: meanMilliseconds(matching, input.variant),
  };
};

export const formatShadowReport = (report: ShadowReport): string =>
  [
    `Shadow report for cohort ${report.cohort}`,
    `Variant: ${report.variant} at cutoff ${report.cutoff}`,
    `Sampled dialogs: ${report.sampled}`,
    `Predictions: ${report.predictions} from ${report.predictionSessions} sessions`,
    `Agreement: ${percent(report.agreement)}`,
    `95% lower bound: ${percent(report.lowerBound)}`,
    `Potential saves: ${report.potentialSaves} (${percent(report.potentialSaveShare)} of sampled dialogs)`,
    `Actual saves: ${report.actualSaves}`,
    `Judge time: ${milliseconds(report.meanMilliseconds)} mean`,
  ].join('\n') + '\n';
