import { writeFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

interface GitAnswer {
  code?: number;
  stdout?: string;
  stderr?: string;
}

export interface GitFake {
  // Answers a git call whose arguments, joined by spaces, start with prefix. The longest prefix
  // wins. Any other call exits 128.
  answer: (prefix: string, answer: GitAnswer) => void;
}

const script = `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const answers = JSON.parse(readFileSync(process.env.TAU_FAKE_GIT_ANSWERS, 'utf8'));
const joined = process.argv.slice(2).join(' ');
const match = Object.keys(answers)
  .filter((prefix) => joined.startsWith(prefix))
  .sort((left, right) => right.length - left.length)[0];
const answer = match === undefined ? { code: 128, stderr: 'fatal: unexpected ' + joined } : answers[match];
process.stdout.write(answer.stdout ?? '');
process.stderr.write(answer.stderr ?? '');
process.exitCode = answer.code ?? 0;
`;

// A git executable that prints canned answers, to test how the tool reads missing and malformed
// output that real Git does not produce. It is first on PATH until the test ends.
export const createGitFake = async (registerCleanup: RegisterCleanup): Promise<GitFake> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-fake-');
  const answers: Record<string, GitAnswer> = {};
  const answersFile = join(directory, 'answers.json');

  registerCleanup(async () => {
    vi.unstubAllEnvs();
  });

  await writeFile(join(directory, 'git'), script);
  await chmod(join(directory, 'git'), 0o755);
  await writeFile(answersFile, '{}');

  vi.stubEnv('PATH', `${directory}:${process.env['PATH'] ?? ''}`);
  vi.stubEnv('TAU_FAKE_GIT_ANSWERS', answersFile);

  return {
    answer: (prefix, answer) => {
      answers[prefix] = answer;
      writeFileSync(answersFile, JSON.stringify(answers));
    },
  };
};
