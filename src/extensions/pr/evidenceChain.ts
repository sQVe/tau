import { errorMessage } from '../../errors.js';
import type { CoverageDecision, CoverageLinkRequest } from '../../reviewCapture/reviewCapture.js';
import { readChainSelection } from '../../reviewCapture/reviewCapture.js';
import { readChainCoverage } from './coverage.js';
import type { PublicationGap } from './evidenceDecisions.js';

export interface ChainEvidence {
  chain: CoverageLinkRequest[] | null;
  coverage: CoverageDecision | null;
  gaps: PublicationGap[];
}

const readCoverageEvidence = async (
  root: string,
  mergeBase: string,
  chain: CoverageLinkRequest[],
): Promise<Pick<ChainEvidence, 'coverage' | 'gaps'>> => {
  try {
    const coverage = await readChainCoverage(root, { chain, mergeBase });

    if (coverage.status === 'match') {
      return { coverage, gaps: [] };
    }

    const gap: PublicationGap = {
      kind: 'coverageMismatch',
      status: coverage.status,
      reasons: coverage.reasons,
    };

    return { coverage, gaps: [gap] };
  } catch (error) {
    return { coverage: null, gaps: [{ kind: 'coverage', reason: errorMessage(error) }] };
  }
};

export const readChainEvidence = async (
  root: string,
  mergeBase: string,
  review: string | undefined,
): Promise<ChainEvidence> => {
  const request = { mergeBase, ...(review === undefined ? {} : { review }) };

  let selection;

  try {
    selection = await readChainSelection(root, request);
  } catch (error) {
    return { chain: null, coverage: null, gaps: [{ kind: 'chain', reason: errorMessage(error) }] };
  }

  const gaps = selection.gaps.map((gap): PublicationGap => ({ kind: 'reviewChain', gap }));

  if (selection.chain === null) {
    return { chain: null, coverage: null, gaps };
  }

  const coverage = await readCoverageEvidence(root, mergeBase, selection.chain);

  return { chain: selection.chain, coverage: coverage.coverage, gaps: [...gaps, ...coverage.gaps] };
};
