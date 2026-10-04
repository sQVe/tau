import { expect, it } from 'vitest';

import { blockerProblem } from './blockers.js';

it.each([
  { case: 'no slices', blockedBy: [] },
  { case: 'no blockers', blockedBy: [[], []] },
  { case: 'a chain', blockedBy: [[], [1], [2]] },
  { case: 'a join', blockedBy: [[], [1], [1, 2]] },
])('accepts $case', ({ blockedBy }) => {
  expect(blockerProblem(blockedBy)).toBeUndefined();
});

it.each([
  { case: 'a blocker past the last slice', blockedBy: [[], [3]], problem: /slice 2 .* 3/ },
  { case: 'a slice that blocks itself', blockedBy: [[1]], problem: /slice 1 .* 1/ },
  { case: 'a repeated blocker', blockedBy: [[], [1, 1]], problem: /slice 2 .*slice 1/ },
  { case: 'a two-slice cycle', blockedBy: [[2], [1]], problem: /slices 1, 2/ },
  { case: 'a three-slice cycle', blockedBy: [[3], [1], [2]], problem: /slices 1, 3, 2/ },
  { case: 'a cycle after a chain', blockedBy: [[], [1, 3], [2]], problem: /slices 2, 3/ },
])('refuses $case and names the slices', ({ blockedBy, problem }) => {
  expect(blockerProblem(blockedBy)).toMatch(problem);
});
