import { expect, it } from 'vitest';

import { defaultRouteConfidence, describeModelChoice, pickRoutedModel } from './modelRoutes.js';
import type { ClassifierOutcome, ModelChoice, ModelRoute, RoutePick } from './modelRoutes.js';

const profileModel = 'claude-bridge/claude-opus-5-5';
const haiku = 'claude-bridge/claude-haiku-5-5';

const route: ModelRoute = {
  classifier: 'tau-classifier-fixture/router',
  question: 'How wide is this scout brief?',
  labels: new Map([
    ['narrow', { criterion: 'A lookup about known code.', model: haiku }],
    ['wide', { criterion: 'An investigation across many files.', model: profileModel }],
  ]),
  confidence: defaultRouteConfidence,
};

const answered = (label: string, confidence: number): ClassifierOutcome => ({
  kind: 'answered',
  label,
  confidence,
});

it.for<[string, string | undefined, ModelRoute, ClassifierOutcome, RoutePick | undefined]>([
  [
    'a confident narrow answer routes to the narrow model',
    undefined,
    route,
    answered('narrow', 0.9),
    { shadowPick: haiku, label: 'narrow', confidence: 0.9, confidenceCutoff: 0.7 },
  ],
  [
    'a confident wide answer routes to the wide model',
    undefined,
    route,
    answered('wide', 0.7),
    { shadowPick: profileModel, label: 'wide', confidence: 0.7, confidenceCutoff: 0.7 },
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
      confidenceCutoff: 0.7,
    },
  ],
  [
    'an unknown label keeps the profile model',
    undefined,
    route,
    answered('medium', 0.95),
    {
      shadowPick: profileModel,
      label: 'medium',
      confidence: 0.95,
      fallbackReason: 'unknownLabel',
      confidenceCutoff: 0.7,
    },
  ],
  [
    'a classifier error keeps the profile model',
    undefined,
    route,
    { kind: 'error' },
    { shadowPick: profileModel, fallbackReason: 'error', confidenceCutoff: 0.7 },
  ],
  [
    'a classifier timeout keeps the profile model',
    undefined,
    route,
    { kind: 'timeout' },
    { shadowPick: profileModel, fallbackReason: 'timeout', confidenceCutoff: 0.7 },
  ],
  [
    'a skipped classification keeps the profile model',
    undefined,
    route,
    { kind: 'skipped' },
    { shadowPick: profileModel, fallbackReason: 'noRoute', confidenceCutoff: 0.7 },
  ],
  ['an explicit model means no pick', 'other/model', route, answered('narrow', 0.9), undefined],
])('%s', ([, launchModel, routeFact, outcome, expected]) => {
  expect(pickRoutedModel({ launchModel, profileModel, route: routeFact, outcome })).toStrictEqual(
    expected,
  );
});

const halfConfidenceRoute: ModelRoute = { ...route, confidence: 0.5 };

it.for<[string, number, RoutePick]>([
  [
    'a pick at the route cutoff routes',
    0.5,
    { shadowPick: haiku, label: 'narrow', confidence: 0.5, confidenceCutoff: 0.5 },
  ],
  [
    'a pick above the route cutoff routes',
    0.9,
    { shadowPick: haiku, label: 'narrow', confidence: 0.9, confidenceCutoff: 0.5 },
  ],
  [
    'a pick below the route cutoff keeps the profile model',
    0.49,
    {
      shadowPick: profileModel,
      label: 'narrow',
      confidence: 0.49,
      fallbackReason: 'lowConfidence',
      confidenceCutoff: 0.5,
    },
  ],
])('with a route cutoff of 0.5, %s', ([, confidence, expected]) => {
  expect(
    pickRoutedModel({
      launchModel: undefined,
      profileModel,
      route: halfConfidenceRoute,
      outcome: answered('narrow', confidence),
    }),
  ).toEqual(expected);
});

const routinePick: RoutePick = {
  shadowPick: haiku,
  label: 'routine',
  confidence: 0.82,
  confidenceCutoff: 0.7,
};

it.for<[string, ModelChoice, string[]]>([
  ['an explicit launch model names the launch', { kind: 'launch' }, ['launch']],
  [
    'a profile without a route names the missing route',
    { kind: 'profileWithoutRoute' },
    ['no route'],
  ],
  [
    'a routed label names the label, confidence, and cutoff',
    { kind: 'routed', pick: routinePick },
    ['routine', '0.82', '0.7'],
  ],
  [
    'a low confidence fallback names the label, confidence, cutoff, and profile model',
    {
      kind: 'routed',
      pick: {
        shadowPick: profileModel,
        label: 'narrow',
        confidence: 0.69,
        fallbackReason: 'lowConfidence',
        confidenceCutoff: 0.7,
      },
    },
    ['narrow', '0.69', '0.7', 'profile'],
  ],
  [
    'an unknown label fallback names the label and profile model',
    {
      kind: 'routed',
      pick: {
        shadowPick: profileModel,
        label: 'medium',
        confidence: 0.95,
        fallbackReason: 'unknownLabel',
        confidenceCutoff: 0.7,
      },
    },
    ['medium', 'profile'],
  ],
  [
    'a classifier error fallback names the error and profile model',
    {
      kind: 'routed',
      pick: { shadowPick: profileModel, fallbackReason: 'error', confidenceCutoff: 0.7 },
    },
    ['error', 'profile'],
  ],
  [
    'a classifier timeout fallback names the timeout and profile model',
    {
      kind: 'routed',
      pick: { shadowPick: profileModel, fallbackReason: 'timeout', confidenceCutoff: 0.7 },
    },
    ['timeout', 'profile'],
  ],
  [
    'a skipped classification names the classifier as not allowed, not a missing route',
    {
      kind: 'routed',
      pick: { shadowPick: profileModel, fallbackReason: 'noRoute', confidenceCutoff: 0.7 },
    },
    ['classifier', 'not allowed', 'profile'],
  ],
  ['a follow-up names the source model it keeps', { kind: 'followUp' }, ['follow-up', 'source']],
])('%s', ([, choice, facts]) => {
  const reason = describeModelChoice(choice);

  expect(facts.filter((fact) => !reason.includes(fact))).toEqual([]);
});
