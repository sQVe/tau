import { expect, it } from 'vitest';

import { pickRoutedModel } from './modelRoutes.js';
import type { ClassifierOutcome, ModelRoute, RoutePick } from './modelRoutes.js';

const profileModel = 'claude-bridge/claude-opus-5-5';
const haiku = 'claude-bridge/claude-haiku-5-5';

const route: ModelRoute = {
  question: 'How wide is this scout brief?',
  labels: new Map([
    ['narrow', { criterion: 'A lookup about known code.', model: haiku }],
    ['wide', { criterion: 'An investigation across many files.', model: profileModel }],
  ]),
};

const answered = (label: string, confidence: number): ClassifierOutcome => ({
  kind: 'answered',
  label,
  confidence,
});

it.for<
  [string, string | undefined, ModelRoute | undefined, ClassifierOutcome, RoutePick | undefined]
>([
  [
    'a confident narrow answer routes to the narrow model',
    undefined,
    route,
    answered('narrow', 0.9),
    { shadowPick: haiku, label: 'narrow', confidence: 0.9 },
  ],
  [
    'a confident wide answer routes to the wide model',
    undefined,
    route,
    answered('wide', 0.7),
    { shadowPick: profileModel, label: 'wide', confidence: 0.7 },
  ],
  [
    'confidence below 0.7 keeps the profile model',
    undefined,
    route,
    answered('narrow', 0.69),
    {
      shadowPick: profileModel,
      label: 'narrow',
      confidence: 0.69,
      fallbackReason: 'lowConfidence',
    },
  ],
  [
    'an unknown label keeps the profile model',
    undefined,
    route,
    answered('medium', 0.95),
    { shadowPick: profileModel, label: 'medium', confidence: 0.95, fallbackReason: 'unknownLabel' },
  ],
  [
    'a classifier error keeps the profile model',
    undefined,
    route,
    { kind: 'error' },
    { shadowPick: profileModel, fallbackReason: 'error' },
  ],
  [
    'a classifier timeout keeps the profile model',
    undefined,
    route,
    { kind: 'timeout' },
    { shadowPick: profileModel, fallbackReason: 'timeout' },
  ],
  [
    'no route keeps the profile model',
    undefined,
    undefined,
    { kind: 'skipped' },
    { shadowPick: profileModel, fallbackReason: 'noRoute' },
  ],
  [
    'a skipped classification keeps the profile model',
    undefined,
    route,
    { kind: 'skipped' },
    { shadowPick: profileModel, fallbackReason: 'noRoute' },
  ],
  ['an explicit model means no pick', 'other/model', route, answered('narrow', 0.9), undefined],
])('%s', ([, launchModel, routeFact, outcome, expected]) => {
  expect(pickRoutedModel({ launchModel, profileModel, route: routeFact, outcome })).toEqual(
    expected,
  );
});
