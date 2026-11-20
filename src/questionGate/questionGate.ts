import type { JsonObject } from '@earendil-works/pi-ai';

export interface JudgeOption {
  label: string;
  description: string;
  recommended: boolean;
}

export interface JudgeQuestion {
  question: string;
  problem: string;
  impact: string;
  options: JudgeOption[];
}

export type PastOutcome =
  | { kind: 'recommended' }
  | { kind: 'otherOption'; label: string }
  | { kind: 'typed'; text: string };

export interface PastAnswer {
  // Milliseconds since the Unix epoch.
  time: number;
  question: JudgeQuestion;
  outcome: PastOutcome;
}

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
