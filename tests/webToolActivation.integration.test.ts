import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { beforeAll, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { bundledProfileDirectory, parseProfile } from '../src/extensions/subagents/profiles.js';
import { isolateWebAccessConfig } from './isolateWebAccessConfig.js';
import { createBoundSession } from './piSession.js';
import { suiteCleanup, temporaryDirectory } from './temporaryDirectoryHarness.js';
import { createWebAccessExtension } from './webAccessExtensionHarness.js';

const webToolNames = ['fetch_content', 'get_search_content', 'web_search'];

const registerSuiteCleanup = suiteCleanup();

let extensionPaths: string[];

beforeAll(() => {
  const fixtureDirectory = temporaryDirectory(registerSuiteCleanup, 'tau-web-config-');
  const configDirectory = join(fixtureDirectory, 'config');

  mkdirSync(configDirectory, { recursive: true });
  isolateWebAccessConfig(configDirectory, registerSuiteCleanup);

  // Without the setting, pi-web-access activates the web tools eagerly for a model that cannot add
  // tools mid-conversation, which skips the web_enable flow these tests cover.
  writeFileSync(
    join(configDirectory, 'web-search.json'),
    JSON.stringify({ toolActivation: 'dynamic' }),
  );

  extensionPaths = [createWebAccessExtension(fixtureDirectory)];
});

const createDirectory = (registerCleanup: TestContext['onTestFinished']) =>
  temporaryDirectory(registerCleanup, 'tau-web-activation-');

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
