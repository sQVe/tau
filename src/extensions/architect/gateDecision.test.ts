import { expect, it } from 'vitest';

import type { ChoiceOutcome } from '../../classifier/choice.js';
import { gateConfidenceCutoff, gateDecision } from './gateDecision.js';

const answered = (label: string, confidence: number): ChoiceOutcome => ({
  kind: 'answered',
  label,
  confidence,
});

it.each([
  {
    name: 'a confident specified label is specified',
    outcome: answered('specified', 0.9),
    expected: { decision: 'specified', label: 'specified', confidence: 0.9 },
  },
  {
    name: 'a specified label at the cutoff is specified',
    outcome: answered('specified', 0.7),
    expected: { decision: 'specified', label: 'specified', confidence: 0.7 },
  },
  {
    name: 'a specified label below the cutoff is open',
    outcome: answered('specified', 0.69),
    expected: { decision: 'open', label: 'specified', confidence: 0.69 },
  },
  {
    name: 'another confident label is open',
    outcome: answered('open', 0.95),
    expected: { decision: 'open', label: 'open', confidence: 0.95 },
  },
  {
    name: 'a timeout is open',
    outcome: { kind: 'timeout' },
    expected: { decision: 'open', label: null, confidence: null },
  },
  {
    name: 'an error is open',
    outcome: { kind: 'error' },
    expected: { decision: 'open', label: null, confidence: null },
  },
  {
    name: 'an unavailable classifier is open',
    outcome: { kind: 'unavailable' },
    expected: { decision: 'open', label: null, confidence: null },
  },
] as const)('$name', ({ outcome, expected }) => {
  expect(gateDecision({ outcome, cutoff: gateConfidenceCutoff })).toEqual(expected);
});
