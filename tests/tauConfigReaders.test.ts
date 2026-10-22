import { expect, it } from 'vitest';

import { readAllowedModels } from '../src/config/models.js';
import { readBrowserLoginCommand } from '../src/extensions/subagents/browserLogin.js';
import { readProfileModels } from '../src/extensions/subagents/profileModels.js';
import { readTrackerConfig } from '../src/extensions/subagents/trackerConfig.js';
import { loadTddConfig } from '../src/extensions/tdd/config.js';
import { temporaryTauConfig } from './tauConfigHarness.js';

it('leaves TDD config, profiles, and allowed models readable when bulkRead is broken', ({
  onTestFinished,
}) => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-config-readers-',
  );

  writeUser({
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/one' } },
    bulkRead: 'broken',
  });

  writeRepository({ bulkRead: {}, tdd: { productionGlobs: ['lib/**'] } });

  expect(readAllowedModels(location)?.models).toEqual(['a/one']);

  expect(readProfileModels(location, { notify: () => undefined })).toEqual(
    new Map([['scout', 'a/one']]),
  );

  expect(loadTddConfig(location, { notify: () => undefined }).config.productionGlobs).toEqual([
    'lib/**',
  ]);
});

it('leaves TDD config, profiles, and allowed models readable next to a bulkRead model', ({
  onTestFinished,
}) => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-config-readers-',
  );

  writeUser({
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/one' } },
    bulkRead: { model: 'openai-codex/gpt-5.6-luna' },
  });

  writeRepository({ tdd: { productionGlobs: ['lib/**'] } });

  expect(readAllowedModels(location)?.models).toEqual(['a/one']);

  expect(readProfileModels(location, { notify: () => undefined })).toEqual(
    new Map([['scout', 'a/one']]),
  );

  expect(loadTddConfig(location, { notify: () => undefined }).config.productionGlobs).toEqual([
    'lib/**',
  ]);
});

it('keeps every reader working when each block holds unknown keys', ({ onTestFinished }) => {
  const { location, writeUser, writeRepository } = temporaryTauConfig(
    onTestFinished,
    'tau-config-readers-',
  );

  const ui = { notify: () => undefined };

  writeUser({
    allowedModels: ['a/one'],
    profiles: { scout: { model: 'a/one', futureKey: 1 } },
    tracker: {
      agentTeam: 'AI',
      futureKey: 1,
      repositories: { 'sQVe/tau': { team: 'ME', futureKey: 1 } },
    },
    browser: { loginCommand: 'open-browser', futureKey: 1 },
  });

  writeRepository({ tdd: { productionGlobs: ['lib/**'], futureKey: 1 } });

  expect(readAllowedModels(location)?.models).toEqual(['a/one']);
  expect(readProfileModels(location, ui)).toEqual(new Map([['scout', 'a/one']]));

  expect(readTrackerConfig(location, ui, 'sQVe/tau')?.repositories.get('sQVe/tau')?.team).toBe(
    'ME',
  );

  expect(readBrowserLoginCommand(location, ui)).toBe('open-browser');
  expect(loadTddConfig(location, ui).config.productionGlobs).toEqual(['lib/**']);
});
