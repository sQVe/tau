import { expect, it } from 'vitest';

import { decideTypedAnswerReply } from './typedAnswerGuard.js';
import type { BranchFact } from './typedAnswerGuard.js';

const typedResult: BranchFact = { kind: 'askResult', typed: true };
const plainResult: BranchFact = { kind: 'askResult', typed: false };
const text: BranchFact = { kind: 'visibleText' };

it.each([
  { facts: [], kind: 'allow' },
  { facts: [text], kind: 'allow' },
  { facts: [plainResult], kind: 'allow' },
  { facts: [typedResult], kind: 'refuse' },
  { facts: [text, typedResult], kind: 'refuse' },
  { facts: [typedResult, text], kind: 'allow' },
  { facts: [typedResult, plainResult], kind: 'allow' },
  { facts: [plainResult, typedResult], kind: 'refuse' },
  { facts: [typedResult, text, plainResult], kind: 'allow' },
] satisfies { facts: BranchFact[]; kind: string }[])('$facts gives $kind', ({ facts, kind }) => {
  expect(decideTypedAnswerReply(facts).kind).toBe(kind);
});
