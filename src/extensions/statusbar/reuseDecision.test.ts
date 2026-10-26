import { expect, it } from 'vitest';

import { decideReuse } from './reuseDecision.js';
import type { ReuseFacts, SessionKey } from './reuseDecision.js';

const current: SessionKey = { sessionId: 'session-1', leafId: 'entry-1', entryCount: 3 };

const facts = (changes: Partial<ReuseFacts> = {}): ReuseFacts => ({
  current,
  cachedCost: { ...current },
  cachedUsage: { ...current },
  usageAgeMilliseconds: 0,
  modelUnchanged: true,
  ...changes,
});

it.each([
  {
    name: 'reuses both readings for the same session, leaf, and entry count',
    facts: facts(),
    decision: { cost: true, contextUsage: true },
  },
  {
    name: 'reads the cost when no cost is cached',
    facts: facts({ cachedCost: undefined }),
    decision: { cost: false, contextUsage: true },
  },
  {
    name: 'reads the cost after a new session',
    facts: facts({ cachedCost: { ...current, sessionId: 'session-2' } }),
    decision: { cost: false, contextUsage: true },
  },
  {
    name: 'reads the cost after a new leaf',
    facts: facts({ cachedCost: { ...current, leafId: 'entry-2' } }),
    decision: { cost: false, contextUsage: true },
  },
  {
    name: 'reads the cost after the leaf is cleared',
    facts: facts({ cachedCost: { ...current, leafId: null } }),
    decision: { cost: false, contextUsage: true },
  },
  {
    name: 'reads the cost after a new entry',
    facts: facts({ cachedCost: { ...current, entryCount: 4 } }),
    decision: { cost: false, contextUsage: true },
  },
  {
    name: 'reads the context usage when no usage is cached',
    facts: facts({ cachedUsage: undefined, usageAgeMilliseconds: undefined }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'reads the context usage after a new session',
    facts: facts({ cachedUsage: { ...current, sessionId: 'session-2' } }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'reads the context usage after a new leaf',
    facts: facts({ cachedUsage: { ...current, leafId: 'entry-2' } }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'reads the context usage after a new entry',
    facts: facts({ cachedUsage: { ...current, entryCount: 4 } }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'reuses the context usage just under a second old',
    facts: facts({ usageAgeMilliseconds: 999 }),
    decision: { cost: true, contextUsage: true },
  },
  {
    name: 'reads the context usage at exactly a second old',
    facts: facts({ usageAgeMilliseconds: 1000 }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'reads the context usage after the model changes',
    facts: facts({ modelUnchanged: false }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'keeps the cost when only the context usage is stale',
    facts: facts({ usageAgeMilliseconds: 1000, modelUnchanged: false }),
    decision: { cost: true, contextUsage: false },
  },
  {
    name: 'reads the cost and context usage after a new session',
    facts: facts({
      cachedCost: { ...current, sessionId: 'session-2' },
      cachedUsage: { ...current, sessionId: 'session-2' },
    }),
    decision: { cost: false, contextUsage: false },
  },
])('$name', ({ facts: input, decision }) => {
  expect(decideReuse(input)).toEqual(decision);
});
