import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.js';
import { decideChainSelection } from './chainSelectionDecision.js';
import type { ChainEntryFacts, ChainSelection } from './chainSelectionDecision.js';
import { hashOf } from './completedCapture.js';
import type { CaptureRecord } from './record.js';
import { readRecord } from './recordRead.js';
import { listReports } from './reportListing.js';
import { hasWorkerReports } from './reports.js';
import { reviewDirectoryPath, reviewPrefix, workersPath } from './reviewDirectory.js';

export interface ChainSelectionRequest {
  mergeBase: string;
  review?: string;
}

// Sorted by name, so the order of gaps and candidates does not depend on the filesystem.
const listReviewDirectories = async (workers: string): Promise<string[]> => {
  let entries;

  try {
    entries = await readdir(workers, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(reviewPrefix))
    .map((entry) => join(workers, entry.name))
    .toSorted();
};

const targetFacts = ({ target }: CaptureRecord) => {
  if (target.kind !== 'fix') {
    return { kind: target.kind };
  }

  const predecessor =
    target.predecessor === undefined ? undefined : { identity: target.predecessor.identity };

  return { kind: target.kind, review: target.review, predecessor };
};

const readEntry = async (root: string, directory: string): Promise<ChainEntryFacts[]> => {
  const result = await readRecord(directory);

  if (result.status === 'missing') {
    return [];
  }

  if (result.status === 'unreadable') {
    return [{ status: 'malformed', directory, reason: errorMessage(result.error) }];
  }

  const entry: ChainEntryFacts = {
    status: 'read',
    directory,
    base: result.record.base,
    identity: await hashOf(root, result.bytes),
    hasWorkerReports: hasWorkerReports(await listReports(directory)),
    ...targetFacts(result.record),
  };

  return [entry];
};

// Reads the saved captures under .tau/workers and writes nothing. A filesystem failure other than
// a missing directory or record rejects.
export const readChainSelection = async (
  root: string,
  { mergeBase, review }: ChainSelectionRequest,
): Promise<ChainSelection> => {
  const namedReview = review === undefined ? undefined : reviewDirectoryPath(root, review);
  const directories = await listReviewDirectories(join(root, '.tau', workersPath));
  const entries = await Promise.all(directories.map((directory) => readEntry(root, directory)));

  return decideChainSelection({ mergeBase, review: namedReview, entries: entries.flat() });
};
