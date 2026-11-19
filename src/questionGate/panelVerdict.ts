import type { JudgeVerdict } from './questionGate.ts';

export type MemberResult =
  | { kind: 'replied'; text: string }
  | { kind: 'timeout' }
  | { kind: 'error' }
  | { kind: 'unavailable' };

const normalizeReply = (result: MemberResult, labels: readonly string[]): MemberResult => {
  if (result.kind !== 'replied') {
    return result;
  }

  const text = result.text.trim();

  return labels.includes(text) ? { kind: 'replied', text } : { kind: 'error' };
};

export const panelVerdict = (
  results: readonly MemberResult[],
  labels: readonly string[],
  recommended: string,
): JudgeVerdict => {
  const normalized = results.map((result) => normalizeReply(result, labels));
  const kinds = new Set(normalized.map((result) => result.kind));

  if (kinds.has('unavailable')) {
    return { kind: 'unavailable' };
  }

  if (kinds.has('timeout')) {
    return { kind: 'timeout' };
  }

  if (kinds.has('error')) {
    return { kind: 'error' };
  }

  const matching = normalized.filter(
    (result) => result.kind === 'replied' && result.text === recommended,
  ).length;

  return { kind: 'answered', confidence: matching / normalized.length };
};
