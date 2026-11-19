import { expect, it } from 'vitest';

import { modelRefusal } from './modelRefusal.js';

it.each([
  { profile: 'worker', model: 'faux/test', refused: true },
  { profile: 'scout', model: 'faux/test', refused: true },
  { profile: 'qa', model: 'faux/test', refused: true },
  { profile: 'browser', model: 'faux/test', refused: true },
  { profile: 'reviewer', model: 'faux/test', refused: false },
  { profile: 'checker', model: 'faux/test', refused: false },
  { profile: 'worker', model: undefined, refused: false },
  { profile: 'reviewer', model: undefined, refused: false },
] as const)('$profile with $model refused: $refused', ({ profile, model, refused }) => {
  expect(modelRefusal(profile, model) !== undefined).toBe(refused);
});

it('names the allowed profiles and the user config order', () => {
  const refusal = modelRefusal('worker', 'faux/test');

  expect(refusal).toContain('reviewer');
  expect(refusal).toContain('checker');
  expect(refusal).toContain('tau.json');

  expect(refusal).toMatch(
    /roles\.<role>\.profiles\.worker\.model, then profiles\.worker\.model, then profiles\.default\.model/,
  );
});
