import { expect, it } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import type { Exec } from '../../command.js';
import { readProcessGroup } from './processGroup.js';

const fakeExec = (result: Awaited<ReturnType<Exec>>) => {
  const calls: { command: string; commandArguments: string[] }[] = [];

  const exec: Exec = (command, commandArguments) => {
    calls.push({ command, commandArguments });

    return Promise.resolve(result);
  };

  return { exec, calls };
};

it('reads the process group of a process from ps output', async () => {
  const { exec, calls } = fakeExec(succeededResult('  4242\n'));

  await expect(readProcessGroup(exec, 4243)).resolves.toBe(4242);

  expect(calls).toEqual([{ command: 'ps', commandArguments: ['-o', 'pgid=', '-p', '4243'] }]);
});

it('throws when ps fails', async () => {
  const { exec } = fakeExec(failedResult('no such process'));

  await expect(readProcessGroup(exec, 4243)).rejects.toThrow(/4243.*no such process/u);
});

it.each(['', 'abc\n', '0\n', '-5\n', '12 34\n', '1.5\n'])(
  'throws when ps prints %j',
  async (output) => {
    const { exec } = fakeExec(succeededResult(output));

    await expect(readProcessGroup(exec, 4243)).rejects.toThrow(/4243/u);
  },
);
