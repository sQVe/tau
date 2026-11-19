import { expect, it } from 'vitest';

import type { HerdrSpace } from './herdrPane.js';
import { isIdleShell, soleShellPane } from './idleShellDecision.js';

type Terminals = HerdrSpace['tabs'][number]['terminals'];

const spaceWith = (...tabs: Terminals[]): HerdrSpace => ({
  id: 'space-1',
  tabs: tabs.map((terminals) => ({ terminals })),
});

it.each([
  {
    label: 'one tab with one app-less terminal',
    space: spaceWith([{ terminal: 't1', pane: 'p1' }]),
    expected: { terminal: 't1', pane: 'p1' },
  },
  {
    label: 'one tab with one null-app terminal',
    space: spaceWith([{ terminal: 't1', pane: 'p1', app: null }]),
    expected: { terminal: 't1', pane: 'p1' },
  },
  {
    label: 'two tabs',
    space: spaceWith([{ terminal: 't1', pane: 'p1' }], [{ terminal: 't2', pane: 'p2' }]),
    expected: undefined,
  },
  {
    label: 'two terminals in one tab',
    space: spaceWith([
      { terminal: 't1', pane: 'p1' },
      { terminal: 't2', pane: 'p2' },
    ]),
    expected: undefined,
  },
  {
    label: 'a pi terminal',
    space: spaceWith([{ terminal: 't1', pane: 'p1', app: 'pi' }]),
    expected: undefined,
  },
  {
    label: 'a terminal without a pane',
    space: spaceWith([{ terminal: 't1', pane: null }]),
    expected: undefined,
  },
  {
    label: 'a terminal without a pane field',
    space: spaceWith([{ terminal: 't1' }]),
    expected: undefined,
  },
  {
    label: 'a terminal with an empty pane',
    space: spaceWith([{ terminal: 't1', pane: '' }]),
    expected: undefined,
  },
  {
    label: 'a missing space',
    space: undefined,
    expected: undefined,
  },
])('soleShellPane for $label gives $expected', ({ space, expected }) => {
  expect(soleShellPane(space)).toEqual(expected);
});

it.each([
  { label: 'zsh in the folder', name: 'zsh', cwd: '/checkout', expected: true },
  { label: 'bash in the folder', name: 'bash', cwd: '/checkout', expected: true },
  { label: 'vim in the folder', name: 'vim', cwd: '/checkout', expected: false },
  { label: 'zsh in another folder', name: 'zsh', cwd: '/elsewhere', expected: false },
  { label: 'no foreground', foreground: null, expected: false },
  { label: 'a missing foreground', foreground: undefined, expected: false },
])('isIdleShell for $label is $expected', ({ name, cwd, foreground, expected }) => {
  const value = name === undefined ? foreground : { name, cwd };

  expect(isIdleShell(value, '/checkout')).toBe(expected);
});
