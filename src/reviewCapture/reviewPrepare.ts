import { createFreshTauDirectory } from '../tauDirectory.js';
import { pruneEndpointRefs } from './endpointPrune.js';
import { reviewPrefix, workersPath } from './reviewDirectory.js';

// Creates a fresh ignored review directory, then prunes the capture refs of deleted reviews.
export const prepareReviewDirectory = async (root: string, now: number): Promise<string> => {
  const directory = await createFreshTauDirectory(root, workersPath, reviewPrefix);

  await pruneEndpointRefs(root, now);

  return directory;
};
