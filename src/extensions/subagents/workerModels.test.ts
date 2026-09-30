import { expect, it } from 'vitest';

import { availableModels, selectWorkerModel, workerModelLine } from './workerModels.js';

const profiles = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));

it.each([
  {
    launch: 'a/launch',
    profiles: profiles({ scout: 'a/scout', default: 'a/default' }),
    model: 'a/launch',
  },
  {
    launch: undefined,
    profiles: profiles({ scout: 'a/scout', default: 'a/default' }),
    model: 'a/scout',
  },
  {
    launch: undefined,
    profiles: profiles({ worker: 'a/worker', default: 'a/default' }),
    model: 'a/default',
  },
  {
    launch: undefined,
    profiles: profiles({ worker: 'a/worker' }),
    model: 'claude-bridge/claude-opus-5-5',
  },
  { launch: undefined, profiles: profiles(), model: 'claude-bridge/claude-opus-5-5' },
  { launch: 'a/launch', profiles: profiles(), model: 'a/launch' },
  {
    launch: undefined,
    profiles: profiles({ constructor: 'a/other' }),
    model: 'claude-bridge/claude-opus-5-5',
  },
])('selects the scout model $model', ({ launch, profiles: configured, model }) => {
  expect(selectWorkerModel(launch, 'scout', configured)).toBe(model);
});

it.each([
  { scoped: ['a/one', 'a/two'], allowed: undefined, available: ['a/one', 'a/two'] },
  { scoped: ['a/one', 'a/two'], allowed: ['a/two', 'a/three'], available: ['a/two'] },
  { scoped: ['a/one'], allowed: [], available: [] },
  { scoped: [], allowed: undefined, available: [] },
])('keeps the allowed scoped models $available', ({ scoped, allowed, available }) => {
  expect(availableModels(scoped, allowed)).toEqual(available);
});

it('lists every available model and marks each profile default, including unlisted ones', () => {
  const line = workerModelLine(
    ['a/one', 'a/two'],
    ['qa', 'scout', 'worker'],
    profiles({ scout: 'a/two', qa: 'a/three', default: 'a/one' }),
  );

  expect(line).toContain('a/one (worker), a/two (scout), a/three (qa).');
});
