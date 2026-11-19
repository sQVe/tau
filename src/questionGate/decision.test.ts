import { expect, it } from 'vitest';

import { questionGateDecision } from './decision.ts';
import type { JudgeVerdict } from './questionGate.ts';

const answered = (confidence: number): JudgeVerdict => ({ kind: 'answered', confidence });

it.each([
  {
    name: 'confidence above the cutoff decides with that confidence',
    verdict: answered(0.9),
    cutoff: 0.7,
    expected: { decision: 'decide', reason: 'confident', confidence: 0.9 },
  },
  {
    name: 'confidence at the cutoff decides with that confidence',
    verdict: answered(0.7),
    cutoff: 0.7,
    expected: { decision: 'decide', reason: 'confident', confidence: 0.7 },
  },
  {
    name: 'confidence below the cutoff asks and keeps the confidence',
    verdict: answered(0.69),
    cutoff: 0.7,
    expected: { decision: 'ask', reason: 'belowCutoff', confidence: 0.69 },
  },
  {
    name: 'confidence 0 at cutoff 0 decides',
    verdict: answered(0),
    cutoff: 0,
    expected: { decision: 'decide', reason: 'confident', confidence: 0 },
  },
  {
    name: 'a timeout asks without a confidence',
    verdict: { kind: 'timeout' },
    cutoff: 0.7,
    expected: { decision: 'ask', reason: 'timeout', confidence: null },
  },
  {
    name: 'an error asks without a confidence',
    verdict: { kind: 'error' },
    cutoff: 0.7,
    expected: { decision: 'ask', reason: 'error', confidence: null },
  },
  {
    name: 'an unavailable judge asks without a confidence',
    verdict: { kind: 'unavailable' },
    cutoff: 0.7,
    expected: { decision: 'ask', reason: 'unavailable', confidence: null },
  },
] as const)('$name', ({ verdict, cutoff, expected }) => {
  expect(questionGateDecision({ verdict, cutoff })).toEqual(expected);
});
