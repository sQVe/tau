import { expect, it } from 'vitest';

import {
  appUrlRefusal,
  briefLimitRefusal,
  briefWithAppUrl,
  hasAppUrlLine,
  launchEnvironmentRefusal,
} from './launchEnvironment.js';

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

it('writes an app URL line the detector finds for a padded URL', () => {
  const value = ` \n${address}\n `;
  const brief = briefWithAppUrl('Test the form.', value);

  expect(brief).toBe(`Test the form.\n\nApp URL: ${address}`);
  expect(hasAppUrlLine(brief)).toBe(true);
});

it.each([
  { brief: 'ab', limit: 2, refused: false },
  { brief: 'abc', limit: 2, refused: true },
  { brief: '😀😀', limit: 2, refused: false },
  { brief: '😀😀😀', limit: 2, refused: true },
])('brief $brief with limit $limit refused: $refused', ({ brief, limit, refused }) => {
  expect(briefLimitRefusal(brief, limit) !== undefined).toBe(refused);
});

it.each([
  {
    name: 'finds the app URL line the launch appends',
    task: 'Check the team overview.\n\nApp URL: http://localhost:3000',
    expected: true,
  },
  {
    name: 'finds an app URL line at the start of the task',
    task: 'App URL: http://localhost:3000',
    expected: true,
  },
  {
    name: 'finds an app URL line whose URL has leading whitespace',
    task: 'Check the team overview.\n\nApp URL:  http://localhost:3000',
    expected: true,
  },
  {
    name: 'finds an app URL line whose URL has trailing whitespace',
    task: 'Check the team overview.\n\nApp URL: http://localhost:3000  ',
    expected: true,
  },
  {
    name: 'finds no app URL line when the marker is followed by a newline',
    task: 'Check the team overview.\n\nApp URL:\nhttp://localhost:3000',
    expected: false,
  },
  {
    name: 'finds no app URL line when the marker is followed by spaces and a newline',
    task: 'Check the team overview.\n\nApp URL: \nhttp://localhost:3000',
    expected: false,
  },
  {
    name: 'finds an indented app URL line',
    task: 'Check the team overview.\n\n  App URL: http://localhost:3000',
    expected: true,
  },
  {
    name: 'finds no app URL line in a task without one',
    task: 'Check the team overview.',
    expected: false,
  },
  {
    name: 'finds no app URL line in prose that mentions it',
    task: 'The App URL: line is missing.',
    expected: false,
  },
  {
    name: 'finds no app URL line when the value is prose',
    task: 'Check the team overview.\n\nApp URL: see the runbook',
    expected: false,
  },
  {
    name: 'finds no app URL line when the value is none',
    task: 'Check the team overview.\n\nApp URL: none',
    expected: false,
  },
])('$name', ({ task, expected }) => {
  expect(hasAppUrlLine(task)).toBe(expected);
});
