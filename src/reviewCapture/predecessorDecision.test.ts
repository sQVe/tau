import { expect, it } from 'vitest';

import type { GenerationDecision } from './generationDecision.js';
import { decidePredecessor } from './predecessorDecision.js';
import type { PredecessorDecision, PredecessorFacts } from './predecessorDecision.js';

const completed: GenerationDecision = {
  status: 'completed',
  identity: 'identity-one',
  reasons: [],
};

const facts = (given: Partial<PredecessorFacts>): PredecessorFacts => ({
  review: 'review-one',
  version: 5,
  target: 'workingTree',
  hasSnapshot: true,
  generation: completed,
  endpointTree: 'tree-one',
  ...given,
});

const refused = (reason: string) => ({
  status: 'refused',
  reason: expect.stringContaining(reason) as string,
});

it.each([
  {
    name: 'a completed full capture with a complete endpoint',
    facts: facts({}),
    decision: { status: 'chained', endpointTree: 'tree-one' },
  },
  {
    name: 'a completed fix capture with a complete endpoint',
    facts: facts({ target: 'fix', hasSnapshot: false }),
    decision: { status: 'chained', endpointTree: 'tree-one' },
  },
  {
    name: 'a completed full capture with no complete endpoint',
    facts: facts({ version: 3, endpointTree: undefined }),
    decision: { status: 'legacy' },
  },
  {
    name: 'a legacy full capture',
    facts: facts({
      version: 2,
      generation: { status: 'legacy', reasons: ['Version 2 saved no original artifacts.'] },
      endpointTree: undefined,
    }),
    decision: { status: 'legacy' },
  },
  {
    name: 'a legacy capture whose record names an endpoint tree',
    facts: facts({ generation: { status: 'legacy', reasons: [] } }),
    decision: { status: 'legacy' },
  },
  {
    name: 'a version 1 record',
    facts: facts({ version: 1, generation: { status: 'legacy', reasons: [] } }),
    decision: refused('version 1 capture record'),
  },
  {
    name: 'a snapshot target that saved no snapshot',
    facts: facts({ target: 'files', hasSnapshot: false }),
    decision: refused('with no snapshot'),
  },
  {
    name: 'an altered capture',
    facts: facts({ generation: { status: 'altered', reasons: ['The patch changed.'] } }),
    decision: refused('is altered'),
  },
  {
    name: 'a missing capture',
    facts: facts({ generation: { status: 'missing', reasons: ['A tree is gone.'] } }),
    decision: refused('is missing'),
  },
  {
    name: 'an incomplete capture',
    facts: facts({ generation: { status: 'incomplete', reasons: ['capture.json is missing.'] } }),
    decision: refused('is incomplete'),
  },
  {
    name: 'a fix capture with no complete endpoint',
    facts: facts({ target: 'fix', hasSnapshot: false, endpointTree: undefined }),
    decision: refused('fix capture with no complete endpoint'),
  },
] satisfies { name: string; facts: PredecessorFacts; decision: PredecessorDecision | object }[])(
  'decides how a fix compares against $name',
  ({ facts: given, decision }) => {
    expect(decidePredecessor(given)).toEqual(decision);
  },
);
