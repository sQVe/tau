import { expect, it } from 'vitest';

import { decideCoverage } from './coverageDecision.js';
import type {
  CoverageFacts,
  CoverageLinkFacts,
  CoverageStatus,
  LinkRecord,
} from './coverageDecision.js';
import type { GenerationDecision } from './generationDecision.js';

const completed = (identity: string): GenerationDecision => ({
  status: 'completed',
  identity,
  reasons: [],
  endpoint: 'complete',
});

const root = (
  record: Partial<LinkRecord> = {},
  generation = completed('identity-root'),
): CoverageLinkFacts => ({
  status: 'read',
  directory: 'review-root',
  expectedIdentity: 'identity-root',
  record: {
    version: 5,
    target: 'range',
    head: 'head-root',
    gaps: [],
    endpoint: { status: 'complete', baseTree: 'tree-base', tree: 'tree-root', ref: 'refs/root' },
    predecessor: undefined,
    ...record,
  },
  generation,
});

const fix = (
  record: Partial<LinkRecord> = {},
  generation = completed('identity-fix'),
): CoverageLinkFacts => ({
  status: 'read',
  directory: 'review-fix',
  expectedIdentity: 'identity-fix',
  record: {
    version: 5,
    target: 'fix',
    head: 'head-fix',
    gaps: [],
    endpoint: { status: 'complete', baseTree: 'tree-root', tree: 'tree-fix', ref: 'refs/fix' },
    predecessor: { identity: 'identity-root', endpointTree: 'tree-root' },
    ...record,
  },
  generation,
});

const chain = (links: CoverageLinkFacts[], trees: Partial<CoverageFacts> = {}): CoverageFacts => ({
  links,
  mergeBaseTree: 'tree-base',
  headTree: 'tree-fix',
  ...trees,
});

it.each([
  {
    name: 'the predecessor identity differs',
    facts: chain([root(), fix({ predecessor: { identity: 'other', endpointTree: 'tree-root' } })]),
    status: 'mismatch',
    link: 2,
    links: ['match', 'mismatch'],
  },
  {
    name: 'an unknown link precedes a mismatch',
    facts: chain([
      root({}, { status: 'incomplete', reasons: ['capture.json is missing.'] }),
      fix({ predecessor: { identity: 'identity-root', endpointTree: 'other' } }),
    ]),
    status: 'mismatch',
    link: 2,
    links: ['unknown', 'mismatch'],
  },
  {
    name: 'a root and a fix cover the head',
    facts: chain([root(), fix()]),
    status: 'match',
    link: undefined,
    links: ['match', 'match'],
  },
  {
    name: 'a root alone covers the head',
    facts: chain([root()], { headTree: 'tree-root' }),
    status: 'match',
    link: undefined,
    links: ['match'],
  },
  {
    name: 'a link reads as altered',
    facts: chain([root({}, { status: 'altered', reasons: ['patch changed'] }), fix()]),
    status: 'mismatch',
    link: 1,
    links: ['mismatch', 'match'],
  },
  {
    name: 'a link has another identity',
    facts: chain([root(), fix({}, completed('identity-other'))]),
    status: 'mismatch',
    link: 2,
    links: ['match', 'mismatch'],
  },
  {
    name: 'a later link is not a fix',
    facts: chain([root(), fix({ target: 'range', predecessor: undefined })]),
    status: 'mismatch',
    link: 2,
    links: ['match', 'mismatch'],
  },
  {
    name: 'the predecessor endpoint tree differs',
    facts: chain([root(), fix({ predecessor: { identity: 'identity-root', endpointTree: 'x' } })]),
    status: 'mismatch',
    link: 2,
    links: ['match', 'mismatch'],
  },
  {
    name: 'the root base is not the merge base',
    facts: chain([root(), fix()], { mergeBaseTree: 'tree-other' }),
    status: 'mismatch',
    link: 1,
    links: ['mismatch', 'match'],
  },
  {
    name: 'the last endpoint is not the head',
    facts: chain([root(), fix()], { headTree: 'tree-other' }),
    status: 'mismatch',
    link: 2,
    links: ['match', 'mismatch'],
  },
  {
    name: 'the chain is empty',
    facts: chain([]),
    status: 'unsupported',
    link: undefined,
    links: [],
  },
  {
    name: 'the root is not range or workingTree',
    facts: chain([root({ target: 'files' }), fix()]),
    status: 'unsupported',
    link: 1,
    links: ['unsupported', 'match'],
  },
  {
    name: 'a link has record version 3',
    facts: chain([root({ version: 3, endpoint: undefined }), fix()]),
    status: 'unsupported',
    link: 1,
    links: ['unsupported', 'match'],
  },
  {
    name: 'a fix has no predecessor',
    facts: chain([root(), fix({ version: 4, predecessor: undefined })]),
    status: 'unsupported',
    link: 2,
    links: ['match', 'unsupported'],
  },
  {
    name: 'a link has an unsupported endpoint',
    facts: chain([root(), fix({ endpoint: { status: 'unsupported', reasons: ['binary'] } })]),
    status: 'unsupported',
    link: 2,
    links: ['match', 'unsupported'],
  },
  {
    name: 'a link has capture gaps',
    facts: chain([root({ gaps: [{ kind: 'excluded', path: 'b.ts' }] }), fix()]),
    status: 'unsupported',
    link: 1,
    links: ['unsupported', 'match'],
  },
  {
    name: 'a link record cannot be read',
    facts: chain([
      root(),
      {
        status: 'unreadable',
        directory: 'review-fix',
        expectedIdentity: 'identity-fix',
        reason: 'No capture record.',
      },
    ]),
    status: 'unknown',
    link: 2,
    links: ['match', 'unknown'],
  },
  {
    name: 'an unreadable link precedes a fix',
    facts: chain([
      {
        status: 'unreadable',
        directory: 'review-root',
        expectedIdentity: 'identity-root',
        reason: 'Malformed capture record.',
      },
      fix(),
    ]),
    status: 'unknown',
    link: 1,
    links: ['unknown', 'match'],
  },
  {
    name: 'a link reads as missing',
    facts: chain([root({}, { status: 'missing', reasons: ['tree pruned'] }), fix()]),
    status: 'unknown',
    link: 1,
    links: ['unknown', 'match'],
  },
  {
    name: 'a link reads as incomplete',
    facts: chain([root(), fix({}, { status: 'incomplete', reasons: ['no record'] })]),
    status: 'unknown',
    link: 2,
    links: ['match', 'unknown'],
  },
  {
    name: 'a link has an incomplete endpoint',
    facts: chain([root(), fix({ endpoint: { status: 'incomplete', reasons: ['git failed'] } })]),
    status: 'unknown',
    link: 2,
    links: ['match', 'unknown'],
  },
  {
    name: 'Git cannot read the merge base tree',
    facts: chain([root(), fix()], { mergeBaseTree: undefined }),
    status: 'unknown',
    link: 1,
    links: ['unknown', 'match'],
  },
  {
    name: 'Git cannot read the head tree',
    facts: chain([root(), fix()], { headTree: undefined }),
    status: 'unknown',
    link: 2,
    links: ['match', 'unknown'],
  },
] satisfies {
  name: string;
  facts: CoverageFacts;
  status: CoverageStatus;
  link: number | undefined;
  links: CoverageStatus[];
}[])('decides $status when $name', ({ facts, status, link, links }) => {
  const decision = decideCoverage(facts);
  const linkName = link === undefined ? '' : `Link ${link} `;
  const reasonCount = status === 'match' ? 0 : 1;
  const unnamed = decision.reasons.filter((reason) => !reason.startsWith(linkName));

  expect(decision.status).toBe(status);
  expect(decision.link).toBe(link);
  expect(decision.links.map((entry) => entry.status)).toEqual(links);
  expect(decision.reasons).toHaveLength(reasonCount);
  expect(unnamed).toEqual([]);
});

it('reports each matching link with its recorded head and no reasons', () => {
  const decision = decideCoverage(chain([root(), fix()]));

  expect(decision.links).toEqual([
    { link: 1, directory: 'review-root', head: 'head-root', status: 'match', reasons: [] },
    { link: 2, directory: 'review-fix', head: 'head-fix', status: 'match', reasons: [] },
  ]);
});
