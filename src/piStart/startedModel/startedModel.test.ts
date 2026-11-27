import { expect, it } from 'vitest';

import { decideStartedModel } from './startedModel.js';
import type { StartedModelFacts } from './startedModel.js';

const facts = (overrides: Partial<StartedModelFacts> = {}): StartedModelFacts => ({
  requested: { provider: 'claude-bridge', id: 'claude-opus-5-5' },
  argv: ['pi', '--provider', 'claude-bridge', '--model', 'claude-opus-5-5'],
  message: undefined,
  ...overrides,
});

it.each<{ name: string; facts: StartedModelFacts; expected: unknown }>([
  {
    name: 'a requested model that matches the started argv',
    facts: facts(),
    expected: { kind: 'match', model: 'claude-bridge/claude-opus-5-5' },
  },
  {
    name: 'a started argv that runs another model',
    facts: facts({ argv: ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'] }),
    expected: {
      kind: 'mismatch',
      requested: 'claude-bridge/claude-opus-5-5',
      started: 'morph/morph-dsv41flash-1017',
    },
  },
  {
    name: 'no requested model and a model in the argv',
    facts: facts({ requested: { provider: undefined, id: undefined } }),
    expected: {
      kind: 'mismatch',
      requested: 'default',
      started: 'claude-bridge/claude-opus-5-5',
    },
  },
  {
    name: 'a task message that equals the started model value',
    facts: facts({
      argv: ['pi', '--provider', 'claude-bridge', '--model', 'claude-opus-5-5'],
      message: 'claude-opus-5-5',
    }),
    expected: { kind: 'match', model: 'claude-bridge/claude-opus-5-5' },
  },
  {
    name: 'a task message that starts with a model flag',
    facts: facts({
      requested: { provider: undefined, id: undefined },
      argv: ['pi', '--model=other'],
      message: '--model=other',
    }),
    expected: { kind: 'match', model: 'default' },
  },
  {
    name: 'a real model flag before a task message that starts with one',
    facts: facts({
      requested: { provider: undefined, id: 'claude-opus-5-5' },
      argv: ['pi', '--model', 'claude-opus-5-5', '--model=other'],
      message: '--model=other',
    }),
    expected: { kind: 'match', model: 'claude-opus-5-5' },
  },
  {
    name: 'a requested model and no model in the argv',
    facts: facts({ argv: ['pi'] }),
    expected: {
      kind: 'mismatch',
      requested: 'claude-bridge/claude-opus-5-5',
      started: 'default',
    },
  },
  {
    name: 'no requested model and no model in the argv',
    facts: facts({ requested: { provider: undefined, id: undefined }, argv: ['pi'] }),
    expected: { kind: 'match', model: 'default' },
  },
  {
    name: 'a model flag followed by another flag',
    facts: facts({
      requested: { provider: undefined, id: undefined },
      argv: ['pi', '--model', '--provider', 'x'],
    }),
    expected: { kind: 'unreadable' },
  },
  {
    name: 'a model flag with an empty equals value',
    facts: facts({
      requested: { provider: undefined, id: undefined },
      argv: ['pi', '--model='],
    }),
    expected: { kind: 'unreadable' },
  },
  {
    name: 'a provider flag followed by another flag',
    facts: facts({
      requested: { provider: undefined, id: 'claude-opus-5-5' },
      argv: ['pi', '--provider', '--model', 'claude-opus-5-5'],
    }),
    expected: { kind: 'unreadable' },
  },
  {
    name: 'a provider flag with no value and no model flag',
    facts: facts({
      requested: { provider: undefined, id: undefined },
      argv: ['pi', '--provider', '--other'],
    }),
    expected: { kind: 'unreadable' },
  },
  {
    name: 'a task message that starts with --model after the real flag',
    facts: facts({
      requested: { provider: undefined, id: 'claude-opus-5-5' },
      argv: ['pi', '--model', 'claude-opus-5-5', '--model=from-the-task'],
    }),
    expected: { kind: 'match', model: 'claude-opus-5-5' },
  },
  {
    name: 'an equals model before a space-separated model',
    facts: facts({
      requested: { provider: undefined, id: 'claude-opus-5-5' },
      argv: ['pi', '--model=claude-opus-5-5', '--model', 'later'],
    }),
    expected: { kind: 'match', model: 'claude-opus-5-5' },
  },
  {
    name: 'a model given with an equals sign',
    facts: facts({
      requested: { provider: undefined, id: 'claude-opus-5-5' },
      argv: ['pi', '--model=claude-opus-5-5'],
    }),
    expected: { kind: 'match', model: 'claude-opus-5-5' },
  },
  {
    name: 'a provider without a model',
    facts: facts({
      requested: { provider: undefined, id: undefined },
      argv: ['pi', '--provider', 'x'],
    }),
    expected: { kind: 'match', model: 'default' },
  },
])('decides $name', ({ facts: startedFacts, expected }) => {
  expect(decideStartedModel(startedFacts)).toEqual(expected);
});
