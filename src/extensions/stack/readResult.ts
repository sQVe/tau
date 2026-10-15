export interface FailedRead {
  ok: false;
  command: string;
  problem: string;
}

// A read either holds the parsed value or names the command that failed and why. A decision treats
// a failed read as unknown and never guesses past it.
export type Read<Value> = { ok: true; value: Value } | FailedRead;

export interface CommandOutput {
  // null when the command did not run to completion.
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const readOk = <Value>(value: Value): Read<Value> => ({ ok: true, value });

export const readFailed = (command: string, problem: string): FailedRead => ({
  ok: false,
  command,
  problem,
});

const outputPreviewLength = 200;

export const failedExit = (command: string, output: CommandOutput): FailedRead => {
  const detail = (output.stderr || output.stdout).trim().slice(0, outputPreviewLength);

  const status =
    output.exitCode === null ? 'did not finish' : `exited with code ${output.exitCode}`;

  return readFailed(command, detail === '' ? status : `${status}: ${detail}`);
};

export const malformedOutput = (command: string, output: CommandOutput): FailedRead =>
  readFailed(
    command,
    `printed output that cannot be read: ${output.stdout.trim().slice(0, outputPreviewLength)}`,
  );

export const failures = (reads: readonly (Read<unknown> | null)[]): FailedRead[] =>
  reads.flatMap((read) => (read !== null && !read.ok ? [read] : []));

export const describeFailures = (failed: readonly FailedRead[]): string =>
  failed.map((read) => `${read.command} ${read.problem}`).join('; ');
