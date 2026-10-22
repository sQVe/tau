import { expect, it } from 'vitest';

import { argumentAfter, createExecFake } from './execFake.js';

type Key = 'greet' | 'write';

const setUp = () => {
  const writes: string[] = [];

  const fake = createExecFake<Key>({
    keyOf: (command, commandArguments) => {
      if (command !== 'tool') {
        return undefined;
      }

      return commandArguments[0] === 'greet' || commandArguments[0] === 'write'
        ? commandArguments[0]
        : undefined;
    },
    handlerFor: (key) => {
      if (key === 'write') {
        return (commandArguments) => {
          writes.push(commandArguments.join(' '));

          return { code: 3, killed: true, stdout: 'written', stderr: '' };
        };
      }

      return undefined;
    },
  });

  return { fake, writes };
};

it('fails a command the fake was not set up for', async () => {
  const { fake } = setUp();

  const result = await fake.exec('other', ['run'], undefined);

  expect(result).toMatchObject({ code: 1, stdout: '' });
  expect(result.stderr).toContain('other run');
});

it('fails a command with a known key and no handler', async () => {
  const { fake } = setUp();

  expect(await fake.exec('tool', ['greet'], undefined)).toMatchObject({
    code: 1,
    stdout: '',
  });
});

it('records each call with its signal', async () => {
  const { fake } = setUp();
  const { signal } = new AbortController();

  await fake.exec('tool', ['write', 'a'], { signal });
  await fake.exec('other', [], undefined);

  expect(fake.calls).toEqual([
    { command: 'tool', commandArguments: ['write', 'a'], signal },
    { command: 'other', commandArguments: [], signal: undefined },
  ]);
});

it('replaces only stdout and still runs the handler', async () => {
  const { fake, writes } = setUp();

  fake.overrideOutput('write', 'odd');

  const result = await fake.exec('tool', ['write', 'a'], undefined);

  expect(result).toEqual({ code: 3, killed: true, stdout: 'odd', stderr: '' });
  expect(writes).toEqual(['write a']);
});

it('fails a command with the given stderr and skips the handler', async () => {
  const { fake, writes } = setUp();

  fake.failCommand('write', 'boom');

  const result = await fake.exec('tool', ['write', 'a'], undefined);

  expect(result).toEqual({
    code: 1,
    killed: false,
    stdout: '',
    stderr: 'boom',
  });

  expect(writes).toEqual([]);
});

it('fails a command with the default stderr of the fake', async () => {
  const { fake } = setUp();

  fake.failCommand('write');

  expect(await fake.exec('tool', ['write'], undefined)).toMatchObject({
    stderr: 'write failed',
  });
});

it.each([
  {
    name: 'a flag with a value',
    commandArguments: ['--head', 'feature'],
    expected: 'feature',
  },
  {
    name: 'a flag at the end',
    commandArguments: ['--head'],
    expected: undefined,
  },
  { name: 'no flag', commandArguments: ['pr', 'list'], expected: undefined },
])('reads the argument after a flag from $name', ({ commandArguments, expected }) => {
  expect(argumentAfter(commandArguments, '--head')).toBe(expected);
});
