import { errorMessage } from '../errors.js';
import { withGitEnvironment } from '../git.js';
import { readCompletedCapture } from './completedCapture.js';
import { decideCoverage } from './coverageDecision.js';
import type { CoverageDecision, CoverageLinkFacts, LinkRecord } from './coverageDecision.js';
import { readTree } from './endpoint.js';
import { readCaptureRecord } from './record.js';
import type { CaptureRecord } from './record.js';
import { checkReviewDirectory } from './reviewDirectory.js';

export interface CoverageLinkRequest {
  directory: string;
  identity: string;
}

export interface CoverageRequest {
  links: CoverageLinkRequest[];
  mergeBase: string;
  head: string;
}

// A partial clone must not fetch a missing object, so a pruned capture reads as unknown.
const noLazyFetch = { GIT_NO_LAZY_FETCH: '1' };

const linkRecord = (record: CaptureRecord): LinkRecord => ({
  version: record.version,
  target: record.target.kind,
  head: record.head,
  gaps: 'gaps' in record ? record.gaps : [],
  endpoint: 'endpoint' in record ? record.endpoint : undefined,
  predecessor: record.target.kind === 'fix' ? record.target.predecessor : undefined,
});

const readLink = async (
  root: string,
  { directory, identity }: CoverageLinkRequest,
): Promise<CoverageLinkFacts> => {
  const path = await checkReviewDirectory(root, directory);
  let record: CaptureRecord;

  try {
    record = await readCaptureRecord(path);
  } catch (error) {
    return {
      status: 'unreadable',
      directory,
      expectedIdentity: identity,
      reason: errorMessage(error),
    };
  }

  const generation = await readCompletedCapture(root, path, identity);

  return {
    status: 'read',
    directory,
    expectedIdentity: identity,
    record: linkRecord(record),
    generation,
  };
};

const optionalTree = (root: string, revision: string) =>
  readTree(root, revision).catch(() => undefined);

const readChain = async (root: string, request: CoverageRequest) => {
  const links: CoverageLinkFacts[] = [];

  for (const link of request.links) {
    // oxlint-disable-next-line no-await-in-loop -- one link at a time keeps the first input error stable.
    links.push(await readLink(root, link));
  }

  return decideCoverage({
    links,
    mergeBaseTree: await optionalTree(root, request.mergeBase),
    headTree: await optionalTree(root, request.head),
  });
};

// Reads whether the chain covers the head on the merge base and writes no file, ref, or object.
export const readCoverage = (root: string, request: CoverageRequest): Promise<CoverageDecision> =>
  withGitEnvironment(noLazyFetch, () => readChain(root, request));
