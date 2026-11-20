import type { JsonObject } from '@earendil-works/pi-ai';

export type {
  JudgeOption,
  JudgeQuestion,
  PastAnswer,
  PastOutcome,
  ShadowVariant,
} from '../judgeSchema.ts';

export type JudgeVerdict =
  | { kind: 'answered'; confidence: number }
  | { kind: 'timeout' }
  | { kind: 'error' }
  | { kind: 'unavailable' };

export type ClassifierOutcome =
  | { kind: 'answered'; label: string; confidence: number }
  | { kind: 'timeout' }
  | { kind: 'error' }
  | { kind: 'unavailable' };

export type ClassifyQuestion = (
  state: JsonObject,
  question: { instructions: string; criteria: Record<string, string> },
  signal: AbortSignal | undefined,
) => Promise<ClassifierOutcome>;

export interface PanelPrompt {
  system: string;
  user: string;
}

export type PanelReply =
  | { kind: 'replied'; text: string }
  | { kind: 'error' }
  | { kind: 'unavailable' };

export type PanelMember = (prompt: PanelPrompt, signal: AbortSignal) => Promise<PanelReply>;

export { judgeWithClassifier } from './classifierJudge.ts';
export { judgeWithPanel, panelTimeoutMilliseconds } from './panelJudge.ts';
export { readShadowRecords, writeShadowRecord } from './record.ts';

export {
  shadowBatchIntervalMilliseconds,
  shadowDecision,
  shadowEligibility,
} from './shadowDecision.ts';

export type {
  ShadowDecision,
  ShadowDecisionFacts,
  ShadowQuestionFacts,
  ShadowSkipReason,
} from './shadowDecision.ts';

export type {
  ShadowRecord,
  ShadowRecordGap,
  ShadowRecordRead,
  ShadowRecordReadOptions,
  ShadowRecordReader,
  ShadowRecordWriter,
} from './record.ts';
