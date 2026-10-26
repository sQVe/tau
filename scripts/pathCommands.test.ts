import { expect, it } from 'vitest';

import { pathCommands } from './pathCommands.ts';
import type { PathEntry } from './pathCommands.ts';

const file = (name: string, identity: string, executable: boolean): PathEntry => ({
  name,
  isFile: true,
  executable,
  identity,
});

const executable = (name: string, identity: string) => file(name, identity, true);

const directory = (name: string): PathEntry => ({
  name,
  isFile: false,
  executable: false,
  identity: 'd',
});

it.each([
  {
    rule: 'first directory wins for a shared name',
    before: [[executable('node', 'a')], [executable('node', 'b')]],
    after: [[executable('node', 'b')], [executable('node', 'a')]],
    same: false,
  },
  {
    rule: 'reordered directories without shared names are equal',
    before: [[executable('git', '1')], [executable('rg', '2')]],
    after: [[executable('rg', '2')], [executable('git', '1')]],
    same: true,
  },
  {
    rule: 'a duplicate directory is equal',
    before: [[executable('node', 'a')]],
    after: [[executable('node', 'a')], [executable('node', 'a')]],
    same: true,
  },
  {
    rule: 'a changed identity differs',
    before: [[executable('node', 'a')]],
    after: [[executable('node', 'c')]],
    same: false,
  },
  {
    rule: 'a file the caller cannot execute does not shadow a later command',
    before: [[file('node', 'a', false)], [executable('node', 'b')]],
    after: [[executable('node', 'b')]],
    same: true,
  },
  {
    rule: 'a directory does not shadow a later command',
    before: [[directory('node')], [executable('node', 'b')]],
    after: [[executable('node', 'b')]],
    same: true,
  },
  {
    rule: 'a change to a shadowed executable differs',
    before: [[executable('node', 'a')], [executable('node', 'b')]],
    after: [[executable('node', 'a')], [executable('node', 'c')]],
    same: false,
  },
  {
    rule: 'swapping two shadowed executables differs',
    before: [[executable('pi', 'a')], [executable('pi', 'b')], [executable('pi', 'c')]],
    after: [[executable('pi', 'a')], [executable('pi', 'c')], [executable('pi', 'b')]],
    same: false,
  },
  {
    rule: 'reordered directories with the same shadowed executables are equal when the winners stay',
    before: [[executable('node', 'a')], [executable('git', '1')], [executable('node', 'b')]],
    after: [[executable('node', 'a')], [executable('node', 'b')], [executable('git', '1')]],
    same: true,
  },
])('$rule', ({ before, after, same }) => {
  expect(pathCommands(before) === pathCommands(after)).toBe(same);
});
