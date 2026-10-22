import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { bundledProfileDirectory, parseProfile } from '../src/extensions/subagents/profiles.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const webToolNames = ['fetch_content', 'get_search_content', 'web_search'];

const extensionPaths = [
  resolve(import.meta.dirname, '../node_modules/pi-web-access/dist/index.js'),
];

const createDirectory = (registerCleanup: TestContext['onTestFinished']) => {
  const directory = temporaryDirectory(registerCleanup, 'tau-web-activation-');
  isolateWebAccessConfig(join(directory, 'agent'), registerCleanup);

  return directory;
};

it('keeps the scout profile web tools active from the first turn', async ({ onTestFinished }) => {
  const directory = createDirectory(onTestFinished);
  const scoutPath = join(bundledProfileDirectory, 'scout.md');
  const scout = parseProfile(readFileSync(scoutPath, 'utf8'), 'scout', scoutPath);

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [fauxProvider()],
    tools: scout.tools,
    extensionPaths,
  });

  const activeToolNames = session.getActiveToolNames();

  expect(activeToolNames).toEqual(expect.arrayContaining(webToolNames));
  expect(activeToolNames).not.toContain('web_enable');
});

it('lets a parent session enable the hidden web tools with web_enable', async ({
  onTestFinished,
}) => {
  const directory = createDirectory(onTestFinished);
  const provider = fauxProvider();

  const { session } = await createBoundSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [provider],
    extensionPaths,
  });

  expect(session.getActiveToolNames()).toContain('web_enable');
  expect(session.getActiveToolNames()).not.toContain('web_search');

  provider.setResponses([
    fauxAssistantMessage([fauxToolCall('web_enable', {})]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Search the web.');

  expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(webToolNames));
});
