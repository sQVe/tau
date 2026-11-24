import { expect, it } from 'vitest';

import { createHerdrAppFake } from '../../tests/herdrAppFake.js';
import { findPane, listSpaces } from './herdrPane.js';

const layoutOf = (stdout: string) => {
  const fake = createHerdrAppFake();

  fake.overrideOutput('ls', stdout);

  return { fake, runtime: { exec: fake.exec, cwd: '/tmp' } };
};

const space = (id: string, name: string, folder: string, machine: string | null = null) => ({
  id,
  name,
  folder,
  machine,
});

const layout = JSON.stringify({
  spaces: [
    {
      ...space('sp-1', 'platform', '/work/repo'),
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
      ...space('sp-2', 'second', '/work/other'),
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

it('a fake built from listed spaces answers both ls readers', async () => {
  const fake = createHerdrAppFake({
    spaces: [{ id: 'sp-1', name: 'platform', folder: '/work/repo', machine: 'build-2' }],
  });

  const runtime = { exec: fake.exec, cwd: '/tmp' };

  await expect(findPane(runtime, 't1')).resolves.toBeUndefined();

  await expect(listSpaces(runtime)).resolves.toMatchObject([
    { id: 'sp-1', name: 'platform', folder: '/work/repo', machine: 'build-2' },
  ]);
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
  { label: 'without a machine', machine: undefined },
  { label: 'with a machine that is not a string', machine: 2 },
])('a listed space $label is refused', async ({ machine }) => {
  const { runtime } = layoutOf(
    JSON.stringify({ spaces: [{ id: 'sp-1', name: 'platform', folder: '/work/repo', machine }] }),
  );

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
