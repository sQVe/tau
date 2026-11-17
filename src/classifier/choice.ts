export type ChoiceOutcome =
  | { kind: 'answered'; label: string; confidence: number }
  | { kind: 'timeout' }
  | { kind: 'error' }
  | { kind: 'unavailable' };

export interface ChoiceQuestion {
  instructions: string;
  criteria: Record<string, string>;
}

export const classifierTimeoutMilliseconds = 5000;
