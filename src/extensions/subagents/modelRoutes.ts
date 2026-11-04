// Decides the shadow model pick from facts the caller read. tests/structure.test.ts keeps this
// module pure.

export interface RouteLabel {
  criterion: string;
  model: string;
}

// Exactly two labels, in config order.
export interface ModelRoute {
  // A provider/model-id that answers the question.
  classifier: string;
  question: string;
  labels: ReadonlyMap<string, RouteLabel>;
  confidence: number;
}

export type ClassifierOutcome =
  | { kind: 'answered'; label: string; confidence: number }
  | { kind: 'error' }
  | { kind: 'timeout' }
  | { kind: 'skipped' };

export interface RouteFacts {
  launchModel: string | undefined;
  profileModel: string;
  route: ModelRoute;
  outcome: ClassifierOutcome;
}

type FallbackReason = 'lowConfidence' | 'error' | 'timeout' | 'noRoute' | 'unknownLabel';

export interface RoutePick {
  shadowPick: string;
  label?: string;
  confidence?: number;
  fallbackReason?: FallbackReason;
  confidenceCutoff: number;
}

export type RoutedLaunch = RoutePick & { ticketSent: boolean };

// Where a worker's model came from. `profileWithoutRoute` means the profile has no route; a skipped
// classification is a `routed` fallback with `noRoute`.
export type ModelChoice =
  | { kind: 'launch' }
  | { kind: 'profileWithoutRoute' }
  | { kind: 'routed'; pick: RoutePick }
  | { kind: 'followUp' };

export const defaultRouteConfidence = 0.7;

// An explicit launch model means no classification and no pick, so the result is undefined.
export const pickRoutedModel = (facts: RouteFacts): RoutePick | undefined => {
  const { launchModel, profileModel, route, outcome } = facts;

  if (launchModel !== undefined) {
    return undefined;
  }

  const confidenceCutoff = route.confidence;

  const fallback = (fallbackReason: FallbackReason): RoutePick => ({
    shadowPick: profileModel,
    fallbackReason,
    confidenceCutoff,
  });

  if (outcome.kind === 'skipped') {
    return fallback('noRoute');
  }

  if (outcome.kind !== 'answered') {
    return fallback(outcome.kind);
  }

  const { label, confidence } = outcome;
  const routed = route.labels.get(label);

  if (routed === undefined) {
    return { ...fallback('unknownLabel'), label, confidence };
  }

  if (confidence < route.confidence) {
    return { ...fallback('lowConfidence'), label, confidence };
  }

  return { shadowPick: routed.model, label, confidence, confidenceCutoff: route.confidence };
};

const describeFallback = (pick: RoutePick, fallbackReason: FallbackReason): string => {
  if (fallbackReason === 'noRoute') {
    return 'Classification was skipped because the classifier is not allowed or not available, so the profile model runs.';
  }

  if (fallbackReason === 'error') {
    return 'The classifier returned an error, so the profile model runs.';
  }

  if (fallbackReason === 'timeout') {
    return 'The classifier hit its timeout, so the profile model runs.';
  }

  if (fallbackReason === 'unknownLabel') {
    return `The classifier answered ${String(pick.label)}, which is not a route label, so the profile model runs.`;
  }

  return `Route label ${String(pick.label)} had confidence ${String(pick.confidence)}, below the cutoff ${pick.confidenceCutoff}, so the profile model runs.`;
};

const describeRoutedPick = (pick: RoutePick): string => {
  if (pick.fallbackReason !== undefined) {
    return describeFallback(pick, pick.fallbackReason);
  }

  return `Route label ${String(pick.label)} had confidence ${String(pick.confidence)}, at or above the cutoff ${pick.confidenceCutoff}.`;
};

export const describeModelChoice = (choice: ModelChoice): string => {
  if (choice.kind === 'launch') {
    return 'The launch named a model, so no route ran.';
  }

  if (choice.kind === 'profileWithoutRoute') {
    return 'The profile has no route, so the profile model runs.';
  }

  if (choice.kind === 'followUp') {
    return 'The follow-up keeps the model of its source assignment.';
  }

  return describeRoutedPick(choice.pick);
};
