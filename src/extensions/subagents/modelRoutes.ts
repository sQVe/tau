// Decides the shadow model pick from facts the caller read. tests/structure.test.ts keeps this
// module pure.

export interface RouteLabel {
  criterion: string;
  model: string;
}

// Exactly two labels, in config order.
export interface ModelRoute {
  question: string;
  labels: ReadonlyMap<string, RouteLabel>;
}

export type ClassifierOutcome =
  | { kind: 'answered'; label: string; confidence: number }
  | { kind: 'error' }
  | { kind: 'timeout' }
  | { kind: 'skipped' };

export interface RouteFacts {
  launchModel: string | undefined;
  profileModel: string;
  route: ModelRoute | undefined;
  outcome: ClassifierOutcome;
}

type FallbackReason = 'lowConfidence' | 'error' | 'timeout' | 'noRoute' | 'unknownLabel';

export interface RoutePick {
  shadowPick: string;
  label?: string;
  confidence?: number;
  fallbackReason?: FallbackReason;
}

const minimumRouteConfidence = 0.7;

// An explicit launch model means no classification and no pick, so the result is undefined.
export const pickRoutedModel = (facts: RouteFacts): RoutePick | undefined => {
  const { launchModel, profileModel, route, outcome } = facts;

  if (launchModel !== undefined) {
    return undefined;
  }

  const fallback = (fallbackReason: FallbackReason): RoutePick => ({
    shadowPick: profileModel,
    fallbackReason,
  });

  if (route === undefined || outcome.kind === 'skipped') {
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

  if (confidence < minimumRouteConfidence) {
    return { ...fallback('lowConfidence'), label, confidence };
  }

  return { shadowPick: routed.model, label, confidence };
};
