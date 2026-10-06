import { expect, it } from 'vitest';

import { confirmationRefusal } from './confirmationEligibility.js';

it.each([
  { isWorker: true, hasUI: true, refused: true },
  { isWorker: true, hasUI: false, refused: true },
  { isWorker: false, hasUI: false, refused: true },
  { isWorker: false, hasUI: true, refused: false },
])(
  'refuses confirmation with worker $isWorker and UI $hasUI: $refused',
  ({ isWorker, hasUI, refused }) => {
    const refusal = confirmationRefusal({ isWorker, hasUI }, 'Writing to Linear');

    expect(refusal !== undefined).toBe(refused);
  },
);

it('keeps the worker refusal when the worker also has no UI', () => {
  const action = 'Writing to Linear';
  const workerRefusal = confirmationRefusal({ isWorker: true, hasUI: true }, action);
  const noUiRefusal = confirmationRefusal({ isWorker: false, hasUI: false }, action);
  const bothRefusal = confirmationRefusal({ isWorker: true, hasUI: false }, action);

  expect(bothRefusal).toBe(workerRefusal);
  expect(bothRefusal).not.toBe(noUiRefusal);
});
