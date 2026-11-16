import type { ReviewSignals, TaskSignalsRead } from '../../improvement/taskSignals.js';

export type MergeOffer =
  | { kind: 'offer'; signals: SignalName[] }
  | { kind: 'plain' }
  | { kind: 'unknown' };

type SignalName = keyof ReviewSignals;

const signalOrder = [
  'reviewRounds',
  'feedbackRounds',
  'checkFailures',
  'revert',
] as const satisfies readonly SignalName[];

const signalLabels = {
  reviewRounds: 'review rounds',
  feedbackRounds: 'PR feedback rounds',
  checkFailures: 'failed full checks',
  revert: 'revert',
} satisfies Record<SignalName, string>;

export const decideMergeOffer = (read: TaskSignalsRead | undefined): MergeOffer => {
  if (read === undefined || read.status === 'failed') {
    return { kind: 'unknown' };
  }

  const fired = signalOrder.filter((name) => read.signals[name] === 'fired');

  if (fired.length > 0) {
    return { kind: 'offer', signals: fired };
  }

  const hasUnknown = signalOrder.some((name) => read.signals[name] === 'unknown');

  return hasUnknown ? { kind: 'unknown' } : { kind: 'plain' };
};

export const describeMergedPullRequest = (url: string, offer: MergeOffer): string => {
  if (offer.kind === 'plain') {
    return `Pull request ${url} merged.`;
  }

  if (offer.kind === 'unknown') {
    return `Pull request ${url} merged; review signals unknown.`;
  }

  const names = offer.signals.map((name) => signalLabels[name]).join(', ');

  return `Pull request ${url} merged. Its task raised these review signals: ${names}. Offer the user a review of this task with the retrospective skill.`;
};
