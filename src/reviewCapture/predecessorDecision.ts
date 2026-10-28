import type { GenerationDecision } from './generationDecision.js';
import type { PinnedTarget } from './target.js';

export interface PredecessorFacts {
  review: string;
  version: number;
  target: PinnedTarget['kind'];
  hasSnapshot: boolean;
  generation: GenerationDecision;
  endpointTree: string | undefined;
}

export type PredecessorDecision =
  | { status: 'chained'; endpointTree: string }
  | { status: 'legacy' }
  | { status: 'refused'; reason: string };

const isSnapshotTarget = (target: PinnedTarget['kind']) =>
  target === 'workingTree' || target === 'files';

const refused = (reason: string): PredecessorDecision => ({ status: 'refused', reason });

export const statusRefusal = (review: string, generation: GenerationDecision): string =>
  `The capture in ${review} is ${generation.status}, so a fix review cannot compare against it. Nothing was written.\n- ${generation.reasons.join('\n- ')}`;

export const decidePredecessor = ({
  review,
  version,
  target,
  hasSnapshot,
  generation,
  endpointTree,
}: PredecessorFacts): PredecessorDecision => {
  if (version === 1) {
    return refused(
      `${review} holds a version 1 capture record, which saved no snapshot. Capture the review again, then name that review.`,
    );
  }

  if (isSnapshotTarget(target) && !hasSnapshot) {
    return refused(`${review} holds a capture record with no snapshot.`);
  }

  if (generation.status !== 'completed' && generation.status !== 'legacy') {
    return refused(statusRefusal(review, generation));
  }

  if (generation.status === 'completed' && endpointTree !== undefined) {
    return { status: 'chained', endpointTree };
  }

  if (target === 'fix') {
    return refused(
      `${review} holds a fix capture with no complete endpoint, so a fix capture cannot compare against it.`,
    );
  }

  return { status: 'legacy' };
};
