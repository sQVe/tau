import type { Exec } from './exec.js';

interface CommandRuntime {
  exec: Exec;
  cwd: string;
  signal?: AbortSignal | undefined;
}

export const runCommand = async (
  runtime: CommandRuntime,
  command: string,
  commandArguments: string[],
  label: string,
): Promise<string> => {
  const result = await runtime.exec(command, commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  if (result.code !== 0 || result.killed) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`${label} failed: ${output}`);
  }

  return result.stdout;
};
