import type { GenerationDecision } from './generationDecision.js';
import type { RecordedEndpoint } from './record.js';
import type { PinnedTarget } from './target.js';

export type CoverageStatus = 'match' | 'mismatch' | 'unsupported' | 'unknown';

export interface LinkRecord {
  version: number;
  target: PinnedTarget['kind'];
  head: string;
  gaps: { kind: string; path: string }[];
  endpoint: RecordedEndpoint | undefined;
  predecessor: { identity: string; endpointTree: string } | undefined;
}

interface LinkName {
  directory: string;
  expectedIdentity: string;
}

export type CoverageLinkFacts =
  | (LinkName & { status: 'unreadable'; reason: string })
  | (LinkName & { status: 'read'; record: LinkRecord; generation: GenerationDecision });

export interface CoverageFacts {
  links: CoverageLinkFacts[];
  mergeBaseTree: string | undefined;
  headTree: string | undefined;
}

interface CoverageLink {
  link: number;
  directory: string;
  head: string | undefined;
  status: CoverageStatus;
  reasons: string[];
}

export interface CoverageDecision {
  status: CoverageStatus;
  link: number | undefined;
  reasons: string[];
  links: CoverageLink[];
}

type ReadLinkFacts = Extract<CoverageLinkFacts, { status: 'read' }>;

type FailedStatus = Exclude<CoverageStatus, 'match'>;

interface LinkContext {
  previous: CoverageLinkFacts | undefined;
  first: boolean;
  last: boolean;
  facts: CoverageFacts;
}

// A proven difference outranks missing evidence, so the order runs from strongest to weakest.
const failedStatuses: FailedStatus[] = ['mismatch', 'unsupported', 'unknown'];

// Records up to this version save no endpoint, so no later capture can chain on them.
const lastUnchainedVersion = 3;

const rootTargets = new Set<PinnedTarget['kind']>(['range', 'workingTree']);

const completeEndpoint = (link: CoverageLinkFacts | undefined) => {
  const endpoint = link?.status === 'read' ? link.record.endpoint : undefined;

  return endpoint?.status === 'complete' ? endpoint : undefined;
};

const generationMismatch = ({ generation, expectedIdentity }: ReadLinkFacts) => {
  if (generation.status === 'altered') {
    return generation.reasons;
  }

  if (generation.status === 'completed' && generation.identity !== expectedIdentity) {
    return [
      `The capture record identity is ${generation.identity}, not the expected ${expectedIdentity}.`,
    ];
  }

  return [];
};

const predecessorMismatch = (link: ReadLinkFacts, previous: CoverageLinkFacts | undefined) => {
  const { predecessor } = link.record;

  if (previous === undefined || predecessor === undefined) {
    return [];
  }

  const reasons: string[] = [];
  const previousTree = completeEndpoint(previous)?.tree;

  if (predecessor.identity !== previous.expectedIdentity) {
    reasons.push(
      `Its predecessor is the capture ${predecessor.identity}, not the previous link's ${previous.expectedIdentity}.`,
    );
  }

  if (previousTree !== undefined && predecessor.endpointTree !== previousTree) {
    reasons.push(
      `Its predecessor endpoint tree is ${predecessor.endpointTree}, not the previous link's ${previousTree}.`,
    );
  }

  return reasons;
};

const treeMismatch = (link: ReadLinkFacts, { first, last, facts }: LinkContext) => {
  const endpoint = completeEndpoint(link);
  const reasons: string[] = [];

  if (endpoint === undefined) {
    return reasons;
  }

  if (first && facts.mergeBaseTree !== undefined && endpoint.baseTree !== facts.mergeBaseTree) {
    reasons.push(
      `Its base tree is ${endpoint.baseTree}, not the merge base tree ${facts.mergeBaseTree}.`,
    );
  }

  if (last && facts.headTree !== undefined && endpoint.tree !== facts.headTree) {
    reasons.push(`Its endpoint tree is ${endpoint.tree}, not the head tree ${facts.headTree}.`);
  }

  return reasons;
};

const mismatchReasons = (link: ReadLinkFacts, context: LinkContext) => {
  const { target } = link.record;

  const kindReasons =
    !context.first && target !== 'fix' ? [`It is a ${target} capture, not a fix capture.`] : [];

  return [
    ...generationMismatch(link),
    ...kindReasons,
    ...predecessorMismatch(link, context.previous),
    ...treeMismatch(link, context),
  ];
};

const unsupportedReasons = ({ record }: ReadLinkFacts, { first }: LinkContext) => {
  const reasons: string[] = [];

  if (first && !rootTargets.has(record.target)) {
    reasons.push(`A ${record.target} capture cannot start a chain; it needs range or workingTree.`);
  }

  if (record.version <= lastUnchainedVersion) {
    reasons.push(`Its capture record has version ${record.version}, which saves no endpoint.`);
  }

  if (record.target === 'fix' && record.predecessor === undefined) {
    reasons.push('It is a fix capture that names no predecessor.');
  }

  if (record.endpoint?.status === 'unsupported') {
    reasons.push(...record.endpoint.reasons);
  }

  reasons.push(...record.gaps.map((gap) => `The capture has a ${gap.kind} gap at ${gap.path}.`));

  return reasons;
};

const treeUnknown = ({ first, last, facts }: LinkContext) => {
  const reasons: string[] = [];

  if (first && facts.mergeBaseTree === undefined) {
    reasons.push('Git cannot read the merge base tree.');
  }

  if (last && facts.headTree === undefined) {
    reasons.push('Git cannot read the head tree.');
  }

  return reasons;
};

const unknownReasons = (link: CoverageLinkFacts, context: LinkContext) => {
  if (link.status === 'unreadable') {
    return [link.reason, ...treeUnknown(context)];
  }

  const { generation, record } = link;
  const unread = generation.status === 'missing' || generation.status === 'incomplete';
  const generationReasons = unread ? generation.reasons : [];
  const endpointReasons = record.endpoint?.status === 'incomplete' ? record.endpoint.reasons : [];

  return [...generationReasons, ...endpointReasons, ...treeUnknown(context)];
};

const linkReasons = (
  link: CoverageLinkFacts,
  context: LinkContext,
): Record<FailedStatus, string[]> => ({
  mismatch: link.status === 'read' ? mismatchReasons(link, context) : [],
  unsupported: link.status === 'read' ? unsupportedReasons(link, context) : [],
  unknown: unknownReasons(link, context),
});

const decideLink = (facts: CoverageFacts, link: CoverageLinkFacts, index: number): CoverageLink => {
  const context: LinkContext = {
    previous: facts.links[index - 1],
    first: index === 0,
    last: index === facts.links.length - 1,
    facts,
  };

  const reasons = linkReasons(link, context);
  const status = failedStatuses.find((failed) => reasons[failed].length > 0) ?? 'match';
  const number = index + 1;
  const named = status === 'match' ? [] : reasons[status];

  return {
    link: number,
    directory: link.directory,
    head: link.status === 'read' ? link.record.head : undefined,
    status,
    reasons: named.map((reason) => `Link ${number} (${link.directory}): ${reason}`),
  };
};

export const decideCoverage = (facts: CoverageFacts): CoverageDecision => {
  if (facts.links.length === 0) {
    return {
      status: 'unsupported',
      link: undefined,
      reasons: ['The chain names no capture.'],
      links: [],
    };
  }

  const links = facts.links.map((link, index) => decideLink(facts, link, index));

  for (const status of failedStatuses) {
    const failed = links.find((link) => link.status === status);

    if (failed !== undefined) {
      return { status, link: failed.link, reasons: failed.reasons, links };
    }
  }

  return { status: 'match', link: undefined, reasons: [], links };
};
