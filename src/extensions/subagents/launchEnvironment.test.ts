import { expect, it } from 'vitest';

import { appUrlRefusal, briefWithAppUrl, launchEnvironmentRefusal } from './launchEnvironment.js';

it.each([
  { profile: 'qa', url: undefined, refused: false },
  { profile: 'qa', url: 'http://localhost:3000', refused: false },
  { profile: 'browser', url: undefined, refused: false },
  { profile: 'browser', url: 'https://example.com/path?query=1', refused: false },
  { profile: 'qa', url: 'localhost:3000', refused: true },
  { profile: 'browser', url: 'file:///tmp/index.html', refused: true },
  { profile: 'qa', url: 'not a url', refused: true },
  { profile: 'worker', url: 'http://localhost:3000', refused: true },
  { profile: 'worker', url: undefined, refused: false },
])('$profile with url $url refused: $refused', ({ profile, url, refused }) => {
  expect(appUrlRefusal(profile, url) !== undefined).toBe(refused);
});

const worktree = '/worktrees/app';
const address = 'http://localhost:3000';

it.each([
  { profile: 'worker', worktreeExists: false, url: undefined },
  { profile: 'browser', worktreeExists: true, url: undefined },
  { profile: 'qa', worktreeExists: true, url: { address, answers: true } },
])('$profile with worktree $worktreeExists and url $url starts', (facts) => {
  expect(launchEnvironmentRefusal({ ...facts, worktree })).toBeUndefined();
});

it.each([
  { profile: 'qa', worktreeExists: false, url: undefined, names: worktree },
  { profile: 'qa', worktreeExists: false, url: { address, answers: false }, names: worktree },
  { profile: 'qa', worktreeExists: true, url: { address, answers: false }, names: address },
  { profile: 'browser', worktreeExists: true, url: { address, answers: false }, names: address },
])(
  '$profile with worktree $worktreeExists and url $url refuses naming $names',
  ({ names, ...facts }) => {
    expect(launchEnvironmentRefusal({ ...facts, worktree })).toContain(names);
  },
);

it('appends the app URL to the brief only when one is given', () => {
  expect(briefWithAppUrl('Test the form.', undefined)).toBe('Test the form.');
  expect(briefWithAppUrl('Test the form.', address)).toBe(`Test the form.\n\nApp URL: ${address}`);
});
