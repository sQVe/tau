import { expect, it } from 'vitest';

import { createHerdrAppFake, herdrAppSpace } from '../../tests/herdrAppFake.js';
import { findPane, listSpaces } from './herdrPane.js';

const layoutOf = (stdout: string) => {
  const fake = createHerdrAppFake();

  fake.overrideOutput('ls', stdout);

  return { fake, runtime: { exec: fake.exec, cwd: '/tmp' } };
};

const layout = JSON.stringify({
  spaces: [
    {
      ...herdrAppSpace('sp-1', 'platform', '/work/repo'),
      tabs: [
        { terminals: [{ terminal: 't1', pane: 'p1' }] },
        {
          terminals: [
            { terminal: 't2', pane: 'p2' },
            { terminal: 't3', pane: null },
          ],
        },
      ],
    },
    {
      ...herdrAppSpace('sp-2', 'second', '/work/other'),
      tabs: [{ terminals: [{ terminal: 't4', pane: 'p4' }] }],
    },
  ],
});

it.each([
  { terminal: 't1', expected: 'p1' },
  { terminal: 't2', expected: 'p2' },
  { terminal: 't4', expected: 'p4' },
  { terminal: 't3', expected: undefined },
  { terminal: 't9', expected: undefined },
])('the pane of $terminal is $expected', async ({ terminal, expected }) => {
  const { fake, runtime } = layoutOf(layout);

  await expect(findPane(runtime, terminal)).resolves.toBe(expected);
  expect(fake.calls.map((call) => call.commandArguments)).toEqual([['ls']]);
});

it('finds a pane in a listing whose spaces carry no space fields', async () => {
  const { runtime } = layoutOf(
    JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: 't1', pane: 'p1' }] }] }] }),
  );

  await expect(findPane(runtime, 't1')).resolves.toBe('p1');
});

it('a listed space carries the machine it runs on', async () => {
  const fake = createHerdrAppFake();

  fake.overrideOutput(
    'ls',
    JSON.stringify({
      spaces: [
        { id: 'sp-1', name: 'local', folder: '/work/repo', machine: null },
        { id: 'sp-2', name: 'remote', folder: '/work/repo', machine: 'build-2' },
      ],
    }),
  );

  await expect(listSpaces({ exec: fake.exec, cwd: '/tmp' })).resolves.toEqual([
    { id: 'sp-1', name: 'local', folder: '/work/repo', machine: null },
    { id: 'sp-2', name: 'remote', folder: '/work/repo', machine: 'build-2' },
  ]);
});

it.each([
  { label: 'without an id', space: { name: 'platform', folder: '/work/repo', machine: null } },
  { label: 'without a name', space: { id: 'sp-1', folder: '/work/repo', machine: null } },
  { label: 'without a folder', space: { id: 'sp-1', name: 'platform', machine: null } },
  { label: 'without a machine', space: { id: 'sp-1', name: 'platform', folder: '/work/repo' } },
  {
    label: 'with a machine that is not a string',
    space: { id: 'sp-1', name: 'platform', folder: '/work/repo', machine: 2 },
  },
])('a listed space $label is refused', async ({ space }) => {
  const { runtime } = layoutOf(JSON.stringify({ spaces: [space] }));

  await expect(listSpaces(runtime)).rejects.toThrow('herdr-app ls printed unexpected output');
});

it('a layout of the wrong shape is refused', async () => {
  const { runtime } = layoutOf('{"spaces":"none"}');

  await expect(findPane(runtime, 't1')).rejects.toThrow('herdr-app ls printed unexpected output');
});

it('output that is not JSON is refused', async () => {
  const { runtime } = layoutOf('not json');

  await expect(findPane(runtime, 't1')).rejects.toThrow('not JSON');
});
