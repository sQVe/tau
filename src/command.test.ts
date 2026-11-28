import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { failedResult as failedExecResult } from '../tests/execFake.js';
import type { ExecResult } from '../tests/execFake.js';
import { checkOutput, commandFailure, parseJson, runCommand } from './command.js';

const failedResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  ...failedExecResult(''),
  ...overrides,
});

it('falls back to stdout when stderr is whitespace only', () => {
  const failure = commandFailure('herdr-app do', failedResult({ stderr: ' \n', stdout: 'boom' }));

  expect(failure?.message).toBe('herdr-app do failed: boom');
});

it('names the exit status when a failed command printed nothing', () => {
  const failure = commandFailure('herdr-app do', failedResult({ code: 3 }));

  expect(failure?.message).toBe('herdr-app do failed: exit code 3');
});

it('names a killed command that printed nothing', () => {
  const failure = commandFailure('herdr-app do', failedResult({ killed: true }));

  expect(failure?.message).toBe('herdr-app do failed: killed');
});

it('names a killed command that printed output', () => {
  const failure = commandFailure(
    'herdr-app do',
    failedResult({ killed: true, stderr: 'starting pi...' }),
  );

  expect(failure?.message).toBe('herdr-app do failed: starting pi... (killed)');
});

it('keeps the whole failure output when it is long', () => {
  const stderr = `first${'x'.repeat(10_000)}last`;
  const failure = commandFailure('git push', failedResult({ stderr }));

  expect(failure?.message).toBe(`git push failed: ${stderr}`);
});

it('marks a failure whose output the exec cut', () => {
  const failure = commandFailure('git push', failedResult({ stderr: 'boom', truncated: true }));

  expect(failure?.message).toBe('git push failed: boom (output truncated)');
});

it('marks a truncated failure that printed nothing', () => {
  const failure = commandFailure('git push', failedResult({ code: 3, truncated: true }));

  expect(failure?.message).toBe('git push failed: exit code 3 (output truncated)');
});

it('names a killed command whose output was also cut', () => {
  const failure = commandFailure(
    'herdr-app do',
    failedResult({ killed: true, truncated: true, stderr: 'starting pi...' }),
  );

  expect(failure?.message).toBe('herdr-app do failed: starting pi... (killed) (output truncated)');
});

it('names the command when a cancelled call rejects with a non-Error reason', async () => {
  const controller = new AbortController();
  const reason: unknown = 'stopped';

  controller.abort(reason);

  const runtime = {
    cwd: '/tmp',
    signal: controller.signal,
    exec: (
      _command: string,
      _arguments: string[],
      options: { signal?: AbortSignal } | undefined,
    ) => {
      options?.signal?.throwIfAborted();

      return Promise.resolve(failedResult());
    },
  };

  let failure: unknown;

  try {
    await runCommand(runtime, 'git', ['status'], 'git status');
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('git status failed: cancelled');
  expect((failure as Error).cause).toBe(reason);
});

it('returns the value of valid JSON', () => {
  expect(parseJson('tool list', '{"a":[1]}')).toEqual({ a: [1] });
});

it('names the label and a cut start of output that is not JSON, and keeps the parse error', () => {
  const stdout = `oops${'x'.repeat(10_000)}END`;
  let thrown: unknown;

  try {
    parseJson('tool list', stdout);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const { message, cause } = thrown as Error;

  expect(message).toContain('tool list');
  expect(message).toContain('oops');
  expect(message).not.toContain('END');
  expect(cause).toBeInstanceOf(SyntaxError);
});

it('accepts a value that matches the schema', () => {
  const schema = Type.Object({ name: Type.String() });

  expect(() => {
    checkOutput('tool list', schema, { name: 'a' });
  }).not.toThrow();
});

it('names the label and the first failing field of a value that breaks the schema', () => {
  const schema = Type.Object({ name: Type.String() });

  expect(() => {
    checkOutput('tool list', schema, { name: 1 });
  }).toThrow(/tool list.*\/name/u);
});
