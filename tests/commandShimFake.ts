import { execFile } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface CommandAnswer {
  // Matches a call whose arguments, joined by spaces, start with this text. The longest prefix wins.
  prefix: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

export interface CommandOverride {
  // A text that the call's arguments, joined with spaces and padded with one space on each side,
  // hold.
  match: string;
  // Shell lines that run in the shim's own process, so `exec`, `trap`, and `kill -9 $$` act on the
  // process the code under test started. $real is the path of the real program. The call ends with
  // exit 0 unless the script exits first.
  script: string;
}

export interface CommandShimOptions {
  // What a call that matches no override or answer does: run the real program, or exit 128.
  otherCalls: 'real' | 'fail';
  answers?: CommandAnswer[];
  overrides?: CommandOverride[];
}

export interface CommandShim {
  // Adds an answer, or replaces the answer that has the same prefix.
  answer: (answer: CommandAnswer) => void;
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const overrideArm = ({ match, script }: CommandOverride): string =>
  `*${quote(match)}*)\n${script}\nexit 0 ;;`;

const answerArm = ({ prefix, code = 0, stdout = '', stderr = '' }: CommandAnswer): string =>
  `${quote(prefix)}*) printf '%s' ${quote(stdout)}; printf '%s' ${quote(stderr)} >&2; exit ${code} ;;`;

const otherCallLine = (otherCalls: CommandShimOptions['otherCalls']): string =>
  otherCalls === 'real'
    ? 'exec "$real" "$@"'
    : `printf 'fatal: unexpected %s\\n' "$*" >&2; exit 128`;

const shimScript = (
  real: string,
  options: CommandShimOptions,
  answers: Map<string, CommandAnswer>,
): string => {
  const longestFirst = [...answers.values()].toSorted(
    (left, right) => right.prefix.length - left.prefix.length,
  );

  const overrides = options.overrides ?? [];

  const lines = [
    '#!/bin/sh',
    `real=${quote(real)}`,
    'case " $* " in',
    ...overrides.map(overrideArm),
    'esac',
    'case "$*" in',
    ...longestFirst.map(answerArm),
    'esac',
    otherCallLine(options.otherCalls),
  ];

  return `${lines.join('\n')}\n`;
};

// Puts a script named `program` first on PATH until the test ends. A call runs the first override
// it matches, else the answer with the longest matching prefix, else `otherCalls`.
export const installCommandShim = async (
  program: string,
  options: CommandShimOptions,
): Promise<CommandShim> => {
  const directory = temporaryDirectory(onTestFinished, `tau-${program}-shim-`);
  const answers = new Map((options.answers ?? []).map((answer) => [answer.prefix, answer]));

  const { stdout } = await promisify(execFile)('sh', ['-c', `command -v ${quote(program)}`]);
  const real = stdout.trim();

  // A rename replaces the script in one step, so a running call never reads a partial file.
  const writeScript = () => {
    const pending = join(directory, `${program}.pending`);

    writeFileSync(pending, shimScript(real, options, answers), { mode: 0o755 });
    renameSync(pending, join(directory, program));
  };

  writeScript();
  vi.stubEnv('PATH', `${directory}:${process.env['PATH'] ?? ''}`);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  return {
    answer: (answer) => {
      answers.set(answer.prefix, answer);
      writeScript();
    },
  };
};
