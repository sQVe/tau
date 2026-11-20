import { expect, it } from 'vitest';

import { createExecFake, succeededResult } from '../../tests/execFake.js';
import { findPane } from './herdrPane.js';

const layoutOf = (stdout: string) => {
  const fake = createExecFake<'app'>({
    keyOf: (command) => (command === 'herdr-app' ? 'app' : undefined),
    handlerFor: () => () => succeededResult(stdout),
  });

  return { fake, runtime: { exec: fake.exec, cwd: '/tmp' } };
};

const layout = JSON.stringify({
  spaces: [
    {
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
    { tabs: [{ terminals: [{ terminal: 't4', pane: 'p4' }] }] },
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

it('a layout of the wrong shape is refused', async () => {
  const { runtime } = layoutOf('{"spaces":"none"}');

  await expect(findPane(runtime, 't1')).rejects.toThrow('herdr-app ls printed unexpected output');
});

it('output that is not JSON is refused', async () => {
  const { runtime } = layoutOf('not json');

  await expect(findPane(runtime, 't1')).rejects.toThrow('not JSON');
});
