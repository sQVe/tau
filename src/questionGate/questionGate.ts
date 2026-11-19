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
