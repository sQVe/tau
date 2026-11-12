import { expect, it } from 'vitest';

import { decideChainSelection } from './chainSelectionDecision.js';
import type {
  ChainEntryFacts,
  ChainSelection,
  ChainSelectionFacts,
} from './chainSelectionDecision.js';

type ReadEntryFacts = Extract<ChainEntryFacts, { status: 'read' }>;
type RootFacts = Exclude<ReadEntryFacts, { kind: 'fix' }>;
type FixFacts = Extract<ReadEntryFacts, { kind: 'fix' }>;

const workers = '/repository/.tau/workers';

const directory = (name: string) => `${workers}/review-${name}`;

const root = (name: string, fields: Partial<RootFacts> = {}): ChainEntryFacts => ({
  status: 'read',
  directory: directory(name),
  kind: 'range',
  base: 'base',
  identity: `own-${name}`,
  hasWorkerReports: true,
  ...fields,
});

const fix = (
  name: string,
  predecessor: string,
  fields: Partial<FixFacts> = {},
): ChainEntryFacts => ({
  status: 'read',
  directory: directory(name),
  kind: 'fix',
  base: 'base',
  identity: `own-${name}`,
  hasWorkerReports: false,
  review: directory(predecessor),
  predecessor: { identity: `recorded-${predecessor}` },
  ...fields,
});

const malformed = (name: string): ChainEntryFacts => ({
  status: 'malformed',
  directory: directory(name),
  reason: `${name} is not JSON`,
});

const facts = (entries: ChainEntryFacts[], review?: string): ChainSelectionFacts => ({
  mergeBase: 'base',
  review,
  entries,
});

const link = (name: string, identity: string) => ({ directory: directory(name), identity });

const cases: { name: string; facts: ChainSelectionFacts; selection: ChainSelection }[] = [
  {
    name: 'one review',
    facts: facts([root('a')]),
    selection: { chain: [link('a', 'own-a')], gaps: [] },
  },
  {
    name: 'a review with two fix reviews',
    facts: facts([fix('c', 'b'), root('a'), fix('b', 'a')]),
    selection: {
      chain: [link('a', 'recorded-a'), link('b', 'recorded-b'), link('c', 'own-c')],
      gaps: [],
    },
  },
  {
    name: 'a workingTree root',
    facts: facts([root('a', { kind: 'workingTree' })]),
    selection: { chain: [link('a', 'own-a')], gaps: [] },
  },
  {
    name: 'a predecessor named by another path',
    facts: facts([root('a'), fix('b', 'a', { review: 'elsewhere/review-a/' })]),
    selection: { chain: [link('a', 'recorded-a'), link('b', 'own-b')], gaps: [] },
  },
  {
    name: 'a fix whose predecessor is missing',
    facts: facts([fix('b', 'a')]),
    selection: {
      chain: null,
      gaps: [
        { kind: 'missingLink', directory: directory('b'), predecessor: directory('a') },
        { kind: 'noChain' },
      ],
    },
  },
  {
    name: 'a missing predecessor on another base',
    facts: facts([fix('b', 'a', { base: 'other' })]),
    selection: { chain: null, gaps: [{ kind: 'noChain' }] },
  },
  {
    name: 'a malformed predecessor',
    facts: facts([malformed('a'), fix('b', 'a')]),
    selection: {
      chain: null,
      gaps: [
        { kind: 'malformedCapture', directory: directory('a'), reason: 'a is not JSON' },
        { kind: 'missingLink', directory: directory('b'), predecessor: directory('a') },
        { kind: 'noChain' },
      ],
    },
  },
  {
    name: 'a malformed capture.json',
    facts: facts([malformed('a')]),
    selection: {
      chain: null,
      gaps: [
        { kind: 'malformedCapture', directory: directory('a'), reason: 'a is not JSON' },
        { kind: 'noChain' },
      ],
    },
  },
  {
    name: 'a malformed capture beside a chain',
    facts: facts([root('a'), malformed('x')]),
    selection: {
      chain: [link('a', 'own-a')],
      gaps: [{ kind: 'malformedCapture', directory: directory('x'), reason: 'x is not JSON' }],
    },
  },
  {
    name: 'two candidate chains',
    facts: facts([root('a'), fix('b', 'a'), root('c')]),
    selection: {
      chain: null,
      gaps: [
        {
          kind: 'ambiguousChain',
          candidates: [[directory('a'), directory('b')], [directory('c')]],
        },
      ],
    },
  },
  {
    name: 'a fork with one chain per tip',
    facts: facts([root('a'), fix('b', 'a'), fix('c', 'a'), fix('d', 'c')]),
    selection: {
      chain: null,
      gaps: [
        {
          kind: 'ambiguousChain',
          candidates: [
            [directory('a'), directory('b')],
            [directory('a'), directory('c'), directory('d')],
          ],
        },
      ],
    },
  },
  {
    name: 'two chains narrowed by review',
    facts: facts([root('a'), fix('b', 'a'), root('c')], directory('b')),
    selection: { chain: [link('a', 'recorded-a'), link('b', 'own-b')], gaps: [] },
  },
  {
    name: 'a fork narrowed by a middle link',
    facts: facts([root('a'), fix('b', 'a'), fix('c', 'a'), fix('d', 'c')], 'review-c'),
    selection: {
      chain: [link('a', 'recorded-a'), link('c', 'recorded-c'), link('d', 'own-d')],
      gaps: [],
    },
  },
  {
    name: 'a review that two chains contain',
    facts: facts([root('a'), fix('b', 'a'), fix('c', 'a')], directory('a')),
    selection: {
      chain: null,
      gaps: [
        {
          kind: 'ambiguousChain',
          candidates: [
            [directory('a'), directory('b')],
            [directory('a'), directory('c')],
          ],
        },
      ],
    },
  },
  {
    name: 'a review that no chain contains',
    facts: facts([root('a'), malformed('x')], directory('x')),
    selection: {
      chain: null,
      gaps: [
        { kind: 'malformedCapture', directory: directory('x'), reason: 'x is not JSON' },
        { kind: 'unknownReview', review: directory('x') },
      ],
    },
  },
  {
    name: 'a review and no capture',
    facts: facts([], directory('a')),
    selection: { chain: null, gaps: [{ kind: 'unknownReview', review: directory('a') }] },
  },
  {
    name: 'no capture',
    facts: facts([]),
    selection: { chain: null, gaps: [{ kind: 'noChain' }] },
  },
  {
    name: 'a root without worker reports',
    facts: facts([root('a', { hasWorkerReports: false }), root('b')]),
    selection: { chain: [link('b', 'own-b')], gaps: [] },
  },
  {
    name: 'a root with another base',
    facts: facts([root('a', { base: 'other' }), fix('c', 'a'), root('b')]),
    selection: { chain: [link('b', 'own-b')], gaps: [] },
  },
  {
    name: 'a root of another kind',
    facts: facts([root('a', { kind: 'files' }), root('b', { kind: 'rootCommit' })]),
    selection: { chain: null, gaps: [{ kind: 'noChain' }] },
  },
  {
    name: 'a fix without a predecessor identity',
    facts: facts([root('a'), fix('b', 'a', { predecessor: undefined })]),
    selection: {
      chain: null,
      gaps: [{ kind: 'unavailableIdentity', directory: directory('a') }],
    },
  },
  {
    name: 'an unselected chain without identity',
    facts: facts([root('a'), fix('b', 'a', { predecessor: undefined }), root('c')], 'review-c'),
    selection: { chain: [link('c', 'own-c')], gaps: [] },
  },
];

it.each(cases)('selects the chain for $name', ({ facts: given, selection }) => {
  expect(decideChainSelection(given)).toEqual(selection);
});
