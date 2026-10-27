import { expect, it } from 'vitest';

import { decideGeneration } from './generationDecision.js';
import type { GenerationFacts, GenerationStatus } from './generationDecision.js';

const savedRecord = {
  version: 3,
  identity: 'identity-one',
  recorded: { patch: 'patch-one', input: 'input-one' },
};

const facts = (given: Partial<GenerationFacts>): GenerationFacts => ({
  record: savedRecord,
  observed: { patch: 'patch-one', input: 'input-one', snapshot: undefined },
  expectedIdentity: undefined,
  ...given,
});

const snapshotFacts = (snapshot: string | undefined) =>
  facts({
    record: { ...savedRecord, recorded: { ...savedRecord.recorded, snapshot: 'snapshot-one' } },
    observed: { patch: 'patch-one', input: 'input-one', snapshot },
  });

it.each([
  { name: 'completed', facts: facts({}), status: 'completed', reasonCount: 0 },
  {
    name: 'completed with a matching expected identity',
    facts: facts({ expectedIdentity: 'identity-one' }),
    status: 'completed',
    reasonCount: 0,
  },
  {
    name: 'legacy version 1',
    facts: facts({ record: { version: 1, identity: 'identity-one', recorded: undefined } }),
    status: 'legacy',
    reasonCount: 1,
  },
  {
    name: 'legacy version 2',
    facts: facts({ record: { version: 2, identity: 'identity-one', recorded: undefined } }),
    status: 'legacy',
    reasonCount: 1,
  },
  { name: 'incomplete', facts: facts({ record: undefined }), status: 'incomplete', reasonCount: 1 },
  {
    name: 'altered patch',
    facts: facts({ observed: { patch: 'patch-two', input: 'input-one', snapshot: undefined } }),
    status: 'altered',
    reasonCount: 1,
  },
  {
    name: 'altered input',
    facts: facts({ observed: { patch: 'patch-one', input: 'input-two', snapshot: undefined } }),
    status: 'altered',
    reasonCount: 1,
  },
  {
    name: 'missing artifact',
    facts: facts({ observed: { patch: undefined, input: 'input-one', snapshot: undefined } }),
    status: 'missing',
    reasonCount: 1,
  },
  {
    name: 'altered patch and missing input',
    facts: facts({ observed: { patch: 'patch-two', input: undefined, snapshot: undefined } }),
    status: 'altered',
    reasonCount: 2,
  },
  {
    name: 'expected identity that differs',
    facts: facts({ expectedIdentity: 'identity-two' }),
    status: 'altered',
    reasonCount: 1,
  },
  {
    name: 'completed with a snapshot',
    facts: snapshotFacts('snapshot-one'),
    status: 'completed',
    reasonCount: 0,
  },
  {
    name: 'altered snapshot',
    facts: snapshotFacts('snapshot-two'),
    status: 'altered',
    reasonCount: 1,
  },
  {
    name: 'missing snapshot copy',
    facts: snapshotFacts(undefined),
    status: 'missing',
    reasonCount: 1,
  },
] satisfies {
  name: string;
  facts: GenerationFacts;
  status: GenerationStatus;
  reasonCount: number;
}[])('decides $name as $status', ({ facts: given, status, reasonCount }) => {
  const decision = decideGeneration(given);

  expect(decision.status).toBe(status);
  expect(decision.reasons).toHaveLength(reasonCount);
});

it('returns completed with the identity of the saved record', () => {
  expect(decideGeneration(facts({}))).toEqual({
    status: 'completed',
    identity: 'identity-one',
    reasons: [],
  });
});
