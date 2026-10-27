import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { appendedSystemPrompt, fakeExtensionApi } from '../../../tests/extensionApi.js';
import { initializeRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import trackerExtension from './tracker.js';

const addOrigin = async (directory: string, originUrl: string) => {
  await promisify(execFile)('git', ['remote', 'add', 'origin', originUrl], { cwd: directory });
};

// Starts a manager session in a checkout whose user tau.json holds `user`, and returns the prompt.
const sessionPrompt = async (
  onTestFinished: (cleanup: () => void) => void,
  config: { user: unknown; originUrl?: string; inheritedGitDirectory?: string },
) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-tracker-prompt-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HERDR_ENV', '0');
  vi.stubEnv('HERDR_PANE_ID', '');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  writeFileSync(join(directory, 'tau.json'), JSON.stringify(config.user));

  if (config.originUrl !== undefined) {
    await initializeRepository(directory);
    await addOrigin(directory, config.originUrl);
  }

  if (config.inheritedGitDirectory !== undefined) {
    vi.stubEnv('GIT_DIR', config.inheritedGitDirectory);
  }

  const fake = fakeExtensionApi();
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    ui: { notify },
  } as unknown as ExtensionContext;

  trackerExtension(fake.pi);

  for (const handler of fake.handlers.get('session_start') ?? []) {
    await handler({} as never, context);
  }

  return { prompt: appendedSystemPrompt(fake.handlers, [], context), notify };
};

it('names the agent team and the repository route with no herdr and no subagent tool', async ({
  onTestFinished,
}) => {
  const { prompt } = await sessionPrompt(onTestFinished, {
    user: {
      tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau' } } },
    },
    originUrl: 'https://github.com/sQVe/tau.git',
  });

  expect(prompt).toContain('Tracker agent team: `AI`.');
  expect(prompt).toContain('Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.');
});

it('reads the origin of the session directory when Pi inherits GIT_DIR for another repository', async ({
  onTestFinished,
}) => {
  const other = temporaryDirectory(onTestFinished, 'tau-tracker-other-');

  await initializeRepository(other);
  await addOrigin(other, 'git@github.com:sQVe/other.git');

  const { prompt } = await sessionPrompt(onTestFinished, {
    user: { tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME' } } } },
    originUrl: 'git@github.com:sQVe/tau.git',
    inheritedGitDirectory: join(other, '.git'),
  });

  expect(prompt).toContain('Tracker repository: `sQVe/tau` uses team `ME`');
});

it('states a missing origin remote in the prompt', async ({ onTestFinished }) => {
  const { prompt } = await sessionPrompt(onTestFinished, {
    user: { tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME' } } } },
  });

  expect(prompt).toContain('Tracker setup needed: this checkout has no origin remote');
  expect(prompt).not.toContain('Tracker repository:');
});

it('states an invalid tracker config in the prompt instead of dropping it', async ({
  onTestFinished,
}) => {
  const { prompt } = await sessionPrompt(onTestFinished, {
    user: { slice: { agentTeam: 'AI' } },
    originUrl: 'git@github.com:sQVe/tau.git',
  });

  expect(prompt).toContain('Tracker setup needed:');
  expect(prompt).toContain('tracker.agentTeam');
});

it('reports a bad tracker entry only for the repository the checkout is cloned from', async ({
  onTestFinished,
}) => {
  const user = { tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 5 } } } };

  const own = await sessionPrompt(onTestFinished, {
    user,
    originUrl: 'git@github.com:sQVe/tau.git',
  });

  expect(own.prompt).toContain('tracker.repositories.sQVe/tau.team must be a string');

  const other = await sessionPrompt(onTestFinished, {
    user,
    originUrl: 'git@github.com:sQVe/other.git',
  });

  expect(other.prompt).not.toContain('must be a string');
  expect(other.prompt).toContain('no entry for `sQVe/other`');
});
