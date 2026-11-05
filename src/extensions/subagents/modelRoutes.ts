// Decides the shadow model pick from facts the caller read. tests/structure.test.ts keeps this
// module pure.

import type { ThinkingLevel } from './types.js';

export interface RouteLabel {
  criterion: string;
  model: string;
  thinking?: ThinkingLevel;
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
  profileModel: string;
  route: ModelRoute;
  outcome: ClassifierOutcome;
}

export type RoutePick =
  | {
      shadowPick: string;
      confidenceCutoff: number;
      label: string;
      confidence: number;
      fallbackReason?: 'lowConfidence' | 'unknownLabel';
    }
  | {
      shadowPick: string;
      confidenceCutoff: number;
      fallbackReason: 'error' | 'timeout' | 'noRoute';
    };

export type RoutedLaunch = RoutePick & { ticketSent: boolean };

export type ModelChoice =
  | { kind: 'launch' }
  | { kind: 'profileWithoutRoute' }
  | { kind: 'routed'; pick: RoutePick }
  | { kind: 'followUp' };

export const defaultRouteConfidence = 0.7;

export const pickRoutedModel = (facts: RouteFacts): RoutePick => {
  const { profileModel, route, outcome } = facts;
  const confidenceCutoff = route.confidence;

  if (outcome.kind === 'skipped') {
    return { shadowPick: profileModel, fallbackReason: 'noRoute', confidenceCutoff };
  }

  if (outcome.kind !== 'answered') {
    return { shadowPick: profileModel, fallbackReason: outcome.kind, confidenceCutoff };
  }

  const { label, confidence } = outcome;
  const routed = route.labels.get(label);

  if (routed === undefined) {
    return {
      shadowPick: profileModel,
      label,
      confidence,
      fallbackReason: 'unknownLabel',
      confidenceCutoff,
    };
  }

  if (confidence < route.confidence) {
    return {
      shadowPick: profileModel,
      label,
      confidence,
      fallbackReason: 'lowConfidence',
      confidenceCutoff,
    };
  }

  return { shadowPick: routed.model, label, confidence, confidenceCutoff };
};

// A successful pick chose a label; a fallback runs the profile model, so it has no label thinking.
export const routedThinking = (route: ModelRoute, pick: RoutePick): ThinkingLevel | undefined => {
  if (!('label' in pick) || pick.fallbackReason !== undefined) {
    return undefined;
  }

  return route.labels.get(pick.label)?.thinking;
};

const describeRoutedPick = (pick: RoutePick): string => {
  if (!('label' in pick)) {
    if (pick.fallbackReason === 'noRoute') {
      return 'Classification was skipped because the classifier is not allowed or not available, so the profile model runs.';
    }

    if (pick.fallbackReason === 'error') {
      return 'The classifier returned an error, so the profile model runs.';
    }

    return 'The classifier hit its timeout, so the profile model runs.';
  }

  if (pick.fallbackReason === undefined) {
    return `Route label ${pick.label} had confidence ${pick.confidence}, at or above the cutoff ${pick.confidenceCutoff}.`;
  }

  if (pick.fallbackReason === 'unknownLabel') {
    return `The classifier answered ${pick.label}, which is not a route label, so the profile model runs.`;
  }

  return `Route label ${pick.label} had confidence ${pick.confidence}, below the cutoff ${pick.confidenceCutoff}, so the profile model runs.`;
};

export const describeModelChoice = (choice: ModelChoice): string => {
  if (choice.kind === 'launch') {
    return 'The launch named a model, so no route ran.';
  }

  if (choice.kind === 'profileWithoutRoute') {
    return 'The profile has no usable route, so the profile model runs.';
  }

  if (choice.kind === 'followUp') {
    return 'The follow-up keeps the model of its source assignment.';
  }

  return describeRoutedPick(choice.pick);
};
