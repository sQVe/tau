import { readCoverage } from '../../reviewCapture/reviewCapture.js';
import type { CoverageDecision, CoverageLinkRequest } from '../../reviewCapture/reviewCapture.js';

export interface ChainRequest {
  chain?: CoverageLinkRequest[];
  mergeBase?: string;
  head?: string;
}

const requireChain = (chain: CoverageLinkRequest[] | undefined) => {
  if (chain === undefined || chain.length === 0) {
    throw new Error('coverage needs chain, an ordered array of {directory, identity}, root first.');
  }

  return chain;
};

const requireMergeBase = (mergeBase: string | undefined) => {
  if (mergeBase === undefined) {
    throw new Error('coverage needs mergeBase.');
  }

  return mergeBase;
};

export const readChainCoverage = async (
  root: string,
  request: ChainRequest,
): Promise<CoverageDecision> => {
  const links = requireChain(request.chain);
  const mergeBase = requireMergeBase(request.mergeBase);

  return readCoverage(root, { links, mergeBase, head: request.head ?? 'HEAD' });
};
