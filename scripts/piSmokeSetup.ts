import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { gitEnvironment } from '../src/git.ts';
import { installedPiPath } from './piVersionDrift.ts';

export const git = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnvironment() });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  return result.stdout;
};

export const createScratchRepository = (tau: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-pi-smoke-repo-'));

  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, '.gitignore'), 'node_modules\n');
  writeFileSync(join(directory, 'package.json'), '{ "name": "smoke", "type": "module" }\n');
  writeFileSync(join(directory, 'src', 'answer.ts'), 'export const answer = () => 41;\n');

  writeFileSync(
    join(directory, 'src', 'answer.test.ts'),
    [
      "import { expect, test } from 'vitest';",
      '',
      "import { answer } from './answer.ts';",
      '',
      "test('answer returns 41', () => {",
      '  expect(answer()).toBe(41);',
      '});',
      '',
    ].join('\n'),
  );

  symlinkSync(join(tau, 'node_modules'), join(directory, 'node_modules'));
  git(directory, ['init', '--quiet', '--initial-branch', 'main']);
  git(directory, ['config', 'user.name', 'Smoke']);
  git(directory, ['config', 'user.email', 'smoke@example.com']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '--message', 'chore: initial']);

  return directory;
};

export const piChildEnvironment = (path: string): NodeJS.ProcessEnv => ({
  ...gitEnvironment(),
  PATH: installedPiPath(path, delimiter),
});
