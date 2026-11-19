import { isRecord } from '../../schema.js';

interface OpenAskFact {
  askId: string;
  question: string;
}

export interface FinalHandoverFacts {
  toolName: string;
  input: unknown;
  openAsks: readonly OpenAskFact[];
}

export type FinalHandoverDecision = { kind: 'allow' } | { kind: 'block'; reason: string };

export const isFinalHandoverSend = (toolName: string, input: unknown): boolean => {
  if (toolName !== 'handover' || !isRecord(input)) {
    return false;
  }

  return input['action'] === 'send' && input['final'] === true;
};

export const decideFinalHandover = (facts: FinalHandoverFacts): FinalHandoverDecision => {
  if (!isFinalHandoverSend(facts.toolName, facts.input) || facts.openAsks.length === 0) {
    return { kind: 'allow' };
  }

  const asks = facts.openAsks.map((ask) => `ask ${ask.askId}: "${ask.question}"`).join('; ');

  return {
    kind: 'block',
    reason: `Blocked the final handover: the lead waits for ${asks}. Answer each with architect answer and its askId first.`,
  };
};
