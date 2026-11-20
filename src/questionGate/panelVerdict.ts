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
  const trimmedLabels = labels.map((label) => label.trim());

  if (new Set(trimmedLabels).size !== trimmedLabels.length) {
    return { kind: 'error' };
  }

  const votes: string[] = [];
  const failures = new Set<Exclude<MemberResult['kind'], 'replied'>>();

  for (const result of results) {
    const normalized = normalizeReply(result, trimmedLabels);

    if (normalized.kind === 'replied') {
      votes.push(normalized.text);
    } else {
      failures.add(normalized.kind);
    }
  }

  if (failures.has('unavailable')) {
    return { kind: 'unavailable' };
  }

  if (failures.has('timeout')) {
    return { kind: 'timeout' };
  }

  if (failures.has('error')) {
    return { kind: 'error' };
  }

  const wanted = recommended.trim();
  const matching = votes.filter((text) => text === wanted).length;

  return { kind: 'answered', confidence: matching / votes.length };
};
