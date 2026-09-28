import { expect, it } from 'vitest';

import { effectiveAllowedModels } from './allowedModels.js';

const user = (models?: string[]) => ({ source: 'user', models });
const repository = (models?: string[]) => ({ source: 'repository', models });

it.each([
  { layers: [], allowed: undefined },
  { layers: [user(), repository()], allowed: undefined },
  { layers: [user(['a/one'])], allowed: { models: ['a/one'], sources: ['user'] } },
  { layers: [repository(['a/one'])], allowed: { models: ['a/one'], sources: ['repository'] } },
  {
    layers: [user(['a/one', 'a/two']), repository(['a/two'])],
    allowed: { models: ['a/two'], sources: ['user', 'repository'] },
  },
  {
    layers: [user(['a/one']), repository()],
    allowed: { models: ['a/one'], sources: ['user'] },
  },
  {
    layers: [user(['a/one']), repository([])],
    allowed: { models: [], sources: ['user', 'repository'] },
  },
])('narrows the allowed models with each layer: $allowed', ({ layers, allowed }) => {
  expect(effectiveAllowedModels(layers)).toEqual(allowed);
});

it('refuses a later layer that adds a model the earlier list does not allow', () => {
  const widen = () => effectiveAllowedModels([user(['a/one']), repository(['a/one', 'a/two'])]);

  expect(widen).toThrow('repository');
  expect(widen).toThrow('a/two');
});
