import { expect, it } from 'vitest';

import { decideFinalHandover } from './finalHandoverDecision.js';
import type { FinalHandoverFacts } from './finalHandoverDecision.js';

const openAsk = { askId: '0190c1d2-0000-7000-8000-000000000401', question: 'Which flag name?' };
const secondAsk = { askId: '0190c1d2-0000-7000-8000-000000000402', question: 'Which default?' };

const facts = (overrides: Partial<FinalHandoverFacts> = {}): FinalHandoverFacts => ({
  toolName: 'handover',
  input: { action: 'send', final: true },
  openAsks: [openAsk],
  ...overrides,
});

it.each([
  {
    name: 'a final handover with an open ask',
    facts: facts(),
    expected: { kind: 'block', reasonIncludes: [openAsk.askId] },
  },
  {
    name: 'a final handover with two open asks',
    facts: facts({ openAsks: [openAsk, secondAsk] }),
    expected: { kind: 'block', reasonIncludes: [openAsk.askId, secondAsk.askId] },
  },
  {
    name: 'a final handover with no open ask',
    facts: facts({ openAsks: [] }),
    expected: { kind: 'allow', reasonIncludes: [] },
  },
  {
    name: 'a handover send without final',
    facts: facts({ input: { action: 'send' } }),
    expected: { kind: 'allow', reasonIncludes: [] },
  },
  {
    name: 'a handover send with final false',
    facts: facts({ input: { action: 'send', final: false } }),
    expected: { kind: 'allow', reasonIncludes: [] },
  },
  {
    name: 'a handover action other than send',
    facts: facts({ input: { action: 'start', final: true } }),
    expected: { kind: 'allow', reasonIncludes: [] },
  },
  {
    name: 'a non-handover tool with send-shaped input',
    facts: facts({ toolName: 'architect', input: { action: 'send', final: true } }),
    expected: { kind: 'allow', reasonIncludes: [] },
  },
  {
    name: 'an input that is not an object',
    facts: facts({ input: 'send' }),
    expected: { kind: 'allow', reasonIncludes: [] },
  },
] as const)('$name', ({ facts: decisionFacts, expected }) => {
  const decision = decideFinalHandover(decisionFacts);

  expect(decision.kind).toBe(expected.kind);

  const reason = decision.kind === 'block' ? decision.reason : '';
  const missing = expected.reasonIncludes.filter((askId) => !reason.includes(askId));

  expect(missing).toEqual([]);
});
