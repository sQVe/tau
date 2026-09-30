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
  { launch: undefined, profiles: profiles({ worker: 'a/worker' }), model: undefined },
  { launch: undefined, profiles: profiles(), model: undefined },
  { launch: 'a/launch', profiles: profiles(), model: 'a/launch' },
  { launch: undefined, profiles: profiles({ constructor: 'a/other' }), model: undefined },
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

it('leaves out profiles without a default model', () => {
  const line = workerModelLine(['a/one'], ['qa', 'scout'], profiles({ scout: 'a/two' }));

  expect(line).toContain('a/one, a/two (scout).');
  expect(line).not.toContain('qa');
});

it('gives no line without an available model or a profile default', () => {
  expect(workerModelLine([], ['scout'], profiles())).toBeUndefined();
});
