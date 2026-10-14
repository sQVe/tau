import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { initializeRepository } from '../../../tests/gitRepository.js';
import type { LaunchParameters } from './launchParameters.js';
import { applyQaSettings } from './qaLaunch.js';

interface Fixture {
  worktree: string;
  writeUser: (value: unknown) => void;
}

const repository = 'sQVe/cape';

const notify = vi.fn<() => void>();

const fixture = async (origin: string | undefined): Promise<Fixture> => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-qa-launch-'));
  const agentDirectory = join(directory, 'agent');
  const worktree = join(directory, 'tree');

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(agentDirectory);
  mkdirSync(worktree);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  await initializeRepository(worktree);

  if (origin !== undefined) {
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: worktree });
  }

  return {
    worktree,
    writeUser: (value) => {
      writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(value));
    },
  };
};

const settingsFor = (urlCommand: string) => ({
  qa: {
    repositories: {
      [repository]: { urlCommand, testAccountCommand: 'op read login', dataWrites: false },
    },
  },
});

const launch = (worktree: string, overrides: Partial<LaunchParameters> = {}): LaunchParameters => ({
  task: 'Test it.',
  profile: 'qa',
  cwd: worktree,
  ...overrides,
});

const context = (worktree: string) => ({
  cwd: worktree,
  isProjectTrusted: () => true,
  ui: { notify },
});

const apply = (parameters: LaunchParameters, worktree: string) =>
  applyQaSettings(parameters, undefined, context(worktree) as never);

const scriptPrinting = (worktree: string, output: string, exitCode = 0): string => {
  writeFileSync(
    join(worktree, 'dev-url'),
    `#!/bin/sh\nprintf '%s' '${output}'\nexit ${exitCode}\n`,
  );

  chmodSync(join(worktree, 'dev-url'), 0o755);

  return './dev-url';
};

it('takes the app URL from urlCommand run in the worktree and adds the brief lines', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor(scriptPrinting(worktree, 'http://localhost:4100\n')));

  const resolved = await apply(launch(worktree), worktree);

  expect(resolved.url).toBe('http://localhost:4100');
  expect(resolved.task).toContain('Test account: run `op read login` to read it.');
  expect(resolved.task).toContain('Data writes: not allowed in the dev database.');
});

it('keeps an explicit url and does not run urlCommand', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser(settingsFor('exit 1'));

  const resolved = await apply(launch(worktree, { url: 'http://localhost:9' }), worktree);

  expect(resolved.url).toBe('http://localhost:9');
  expect(resolved.task).toContain('Data writes:');
});

it.each([
  { condition: 'the command fails', output: 'http://localhost:1', exitCode: 3 },
  { condition: 'the output is empty', output: '', exitCode: 0 },
  { condition: 'the output is not http', output: 'ftp://host', exitCode: 0 },
])('refuses the launch when $condition', async ({ output, exitCode }) => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const command = scriptPrinting(worktree, output, exitCode);

  writeUser(settingsFor(command));

  const refusal = apply(launch(worktree), worktree);

  await expect(refusal).rejects.toThrow(command);
  await expect(refusal).rejects.toThrow('qa.repositories');
});

it('never runs testAccountCommand', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const marker = join(worktree, 'ran');

  writeUser({
    qa: {
      repositories: {
        [repository]: {
          urlCommand: 'echo http://localhost:1',
          testAccountCommand: `touch ${marker}`,
        },
      },
    },
  });

  await apply(launch(worktree), worktree);

  expect(existsSync(marker)).toBe(false);
});

it.each([
  {
    condition: 'the profile is browser',
    origin: 'git@github.com:sQVe/cape.git',
    profile: 'browser',
  },
  {
    condition: 'the origin names another repository',
    origin: 'git@github.com:sQVe/tau.git',
    profile: 'qa',
  },
  { condition: 'there is no origin', origin: undefined, profile: 'qa' },
])('leaves the launch unchanged when $condition', async ({ origin, profile }) => {
  const { worktree, writeUser } = await fixture(origin);

  writeUser(settingsFor('exit 1'));

  const parameters = launch(worktree, { profile });

  await expect(apply(parameters, worktree)).resolves.toBe(parameters);
});

it('fails a qa launch for a repository with a bad entry only', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');

  writeUser({ qa: { repositories: { [repository]: { dataWrites: 'yes' } } } });

  await expect(apply(launch(worktree), worktree)).rejects.toThrow('dataWrites');
  await expect(apply(launch(worktree, { profile: 'browser' }), worktree)).resolves.toBeDefined();
});

it('refuses a cwd outside the session before it reads settings or runs a command', async () => {
  const { worktree, writeUser } = await fixture('git@github.com:sQVe/cape.git');
  const other = join(worktree, 'other');
  const marker = join(worktree, 'ran');

  mkdirSync(other);
  writeUser(settingsFor(`touch ${marker}`));

  await expect(apply(launch(other), worktree)).rejects.toThrow("only in this session's cwd");
  expect(existsSync(marker)).toBe(false);
});
