import { expect, it } from 'vitest';

import type { PullView } from './chainDecisions.js';
import type { StackedPullRequests, StackLayer } from './checkDecisions.js';
import { decideLink } from './linkDecisions.js';
import type { LinkFacts } from './linkDecisions.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const lower: PullView = { number: 2, headRefName: 'lower', baseRefName: 'main', state: 'OPEN' };
const upper: PullView = { number: 3, headRefName: 'upper', baseRefName: 'lower', state: 'OPEN' };

const layer = (pull: PullView): StackLayer => ({
  name: pull.headRefName,
  base: pull.baseRefName,
  isCurrent: pull.number === 3,
  isMerged: pull.state === 'MERGED',
  isQueued: false,
  needsRebase: false,
});

const stack = (...pullRequests: number[]): StackedPullRequests => ({
  kind: 'stack',
  number: 102,
  pullRequests,
});

const facts = (overrides: Partial<LinkFacts> = {}): LinkFacts => ({
  remote: 'origin',
  pull: upper,
  view: { trunk: 'main', currentBranch: 'upper', branches: [layer(lower), layer(upper)] },
  localPulls: [lower, upper],
  stacks: { kind: 'none' },
  belowStacks: { kind: 'none' },
  githubPulls: [],
  ...overrides,
});

it.each([
  {
    name: 'new stack',
    input: facts(),
    expected: { result: 'command', command: 'gh stack link --remote origin --base main 2 3' },
  },
  {
    name: 'existing stack',
    input: facts({ belowStacks: stack(2) }),
    expected: { result: 'command', command: 'gh stack link --remote origin 102 3' },
  },
  {
    name: 'missing lower open PR',
    input: facts({
      localPulls: [
        { number: 1, headRefName: 'bottom', baseRefName: 'main', state: 'OPEN' },
        lower,
        upper,
      ],
      belowStacks: stack(2),
    }),
    reason: 'suffix',
  },
  {
    name: 'merged PR kept at bottom',
    input: facts({
      localPulls: [
        { number: 1, headRefName: 'merged', baseRefName: 'main', state: 'MERGED' },
        lower,
        upper,
      ],
      belowStacks: stack(1, 2),
    }),
    expected: { result: 'command', command: 'gh stack link --remote origin 102 3' },
  },
  { name: 'one open PR', input: facts({ localPulls: [upper] }), expected: { result: 'none' } },
  {
    name: 'already linked before checking the lower stack top',
    input: facts({ stacks: stack(2, 3), belowStacks: stack(2, 3), githubPulls: [lower, upper] }),
    expected: { result: 'linked' },
  },
  {
    name: 'branch outside the local stack',
    input: facts({ pull: { ...upper, headRefName: 'other' } }),
    reason: 'local stack',
  },
  { name: 'PR below the local top', input: facts({ pull: lower }), reason: 'top' },
  { name: 'another GitHub top below', input: facts({ belowStacks: stack(2, 9) }), reason: 'top' },
  { name: 'stack API off', input: facts({ stacks: { kind: 'off' } }), reason: 'off' },
  { name: 'lower stack API off', input: facts({ belowStacks: { kind: 'off' } }), reason: 'off' },
  {
    name: 'linked PR is not the GitHub top',
    input: facts({ stacks: stack(3, 2), githubPulls: [upper, lower] }),
    reason: 'top',
  },
  {
    name: 'wrong upper base',
    input: facts({ stacks: stack(2, 3), githubPulls: [lower, { ...upper, baseRefName: 'main' }] }),
    reason: 'base',
  },
  {
    name: 'wrong bottom base',
    input: facts({ stacks: stack(2, 3), githubPulls: [{ ...lower, baseRefName: 'other' }, upper] }),
    reason: 'base',
  },
  { name: 'closed target', input: facts({ pull: { ...upper, state: 'CLOSED' } }), reason: 'open' },
  {
    name: 'stale local top PR',
    input: facts({ localPulls: [lower, { ...upper, number: 9 }] }),
    reason: 'local stack PRs',
  },
  {
    name: 'stack omits target',
    input: facts({ stacks: stack(2), githubPulls: [lower] }),
    reason: 'hold',
  },
  {
    name: 'missing GitHub PR facts',
    input: facts({ stacks: stack(2, 3), githubPulls: [upper] }),
    reason: 'read',
  },
  {
    name: 'merged lower PR is skipped',
    input: facts({
      localPulls: [
        { number: 1, headRefName: 'merged', baseRefName: 'main', state: 'MERGED' },
        lower,
        upper,
      ],
    }),
    expected: { result: 'command', command: 'gh stack link --remote origin --base main 2 3' },
  },
  {
    name: 'merged GitHub PR is skipped for base checks',
    input: facts({
      stacks: stack(1, 2, 3),
      githubPulls: [
        { number: 1, headRefName: 'merged', baseRefName: 'old', state: 'MERGED' },
        lower,
        upper,
      ],
    }),
    expected: { result: 'linked' },
  },
  {
    name: 'shell-sensitive remote and trunk',
    input: facts({
      remote: 'my remote',
      view: { trunk: "topic'base", currentBranch: 'upper', branches: [layer(lower), layer(upper)] },
    }),
    expected: {
      result: 'command',
      command: "gh stack link --remote 'my remote' --base 'topic'\\''base' 2 3",
    },
  },
])('decides $name', ({ input, expected, reason }) => {
  const decision = decideLink(input);

  const outcome = reason === undefined ? expected : { result: 'stop', reason: containing(reason) };

  expect(decision).toEqual(outcome);
});
