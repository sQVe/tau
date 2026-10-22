import type { Exec } from '../src/command.js';

export type ExecResult = Awaited<ReturnType<Exec>>;

type ExecOptions = Parameters<Exec>[2];

export interface ExecCall {
  command: string;
  commandArguments: string[];
  signal: AbortSignal | undefined;
}

export type ExecHandler = (
  commandArguments: readonly string[],
  options: ExecOptions,
) => ExecResult | Promise<ExecResult>;

interface ExecFakeSetup<Key extends string> {
  // Maps a command to the key that tells the commands tests care about apart. undefined fails the call.
  keyOf: (command: string, commandArguments: readonly string[]) => Key | undefined;
  // A key without a handler fails the call.
  handlerFor: (key: Key) => ExecHandler | undefined;
  // The stderr of failCommand when the test names none.
  failureStderr?: (key: Key) => string;
}

export interface ExecFake<Key extends string> {
  exec: Exec;
  calls: ExecCall[];
  // The handler still runs, so its effects stay. Only stdout is replaced.
  overrideOutput: (key: Key, stdout: string) => void;
  failCommand: (key: Key, stderr?: string) => void;
}

export const failedResult = (stderr: string, code = 1): ExecResult => ({
  code,
  killed: false,
  stdout: '',
  stderr,
});

export const succeededResult = (stdout: string): ExecResult => ({
  code: 0,
  killed: false,
  stdout,
  stderr: '',
});

export const argumentAfter = (
  commandArguments: readonly string[],
  flag: string,
): string | undefined => {
  const index = commandArguments.indexOf(flag);

  return index === -1 ? undefined : commandArguments[index + 1];
};

export const createExecFake = <Key extends string>(setup: ExecFakeSetup<Key>): ExecFake<Key> => {
  const calls: ExecCall[] = [];
  const overrides = new Map<Key, string>();
  const failures = new Map<Key, string | undefined>();

  const exec: Exec = async (command, commandArguments, options) => {
    calls.push({
      command,
      commandArguments: [...commandArguments],
      signal: options?.signal,
    });

    const key = setup.keyOf(command, commandArguments);
    const handler = key === undefined ? undefined : setup.handlerFor(key);

    if (key === undefined || handler === undefined) {
      return failedResult(`unknown command: ${[command, ...commandArguments].join(' ')}`);
    }

    if (failures.has(key)) {
      const stderr = failures.get(key) ?? setup.failureStderr?.(key) ?? `${key} failed`;

      return failedResult(stderr);
    }

    const result = await handler(commandArguments, options);
    const stdout = overrides.get(key);

    return stdout === undefined ? result : { ...result, stdout };
  };

  return {
    exec,
    calls,
    overrideOutput: (key, stdout) => {
      overrides.set(key, stdout);
    },
    failCommand: (key, stderr) => {
      failures.set(key, stderr);
    },
  };
};
