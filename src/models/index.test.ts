import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { resolveAllowedModel } from './index.js';

const writeConfig = (path: string, allowedModels: string[] | undefined) => {
  if (allowedModels !== undefined) {
    writeFileSync(path, JSON.stringify({ allowedModels }));
  }
};

const fixture = (
  onTestFinished: (callback: () => void) => void,
  user?: string[],
  repository?: string[],
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-models-allowed-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, '.pi'));
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  const userFile = join(directory, 'tau.json');
  const repositoryFile = join(directory, '.pi', 'tau.json');
  writeConfig(userFile, user);
  writeConfig(repositoryFile, repository);

  const modelRegistry = {
    find: (provider: string, id: string) => ({ provider, id }),
  } as unknown as ModelRegistry;

  const context = { cwd: directory, modelRegistry, isProjectTrusted: () => true };

  return { context, userFile, repositoryFile };
};

it.for<[string, string[] | undefined, string[] | undefined]>([
  ['an absent list', undefined, undefined],
  ['an allowed model', ['a/one', 'a/two'], undefined],
  ['a repository list that narrows', ['a/one', 'a/two'], ['a/two']],
])('resolves the model under %s', ([, user, repository], { onTestFinished }) => {
  const { context } = fixture(onTestFinished, user, repository);

  expect(resolveAllowedModel(context, 'a/two')).toEqual({ provider: 'a', id: 'two' });
});

it.for<[string, string[] | undefined, string[] | undefined, 'userFile' | 'repositoryFile']>([
  ['a model outside the user list', ['a/one'], undefined, 'userFile'],
  ['a model the repository list removes', ['a/one', 'a/two'], ['a/one'], 'repositoryFile'],
  ['a repository list that tries to widen', ['a/one'], ['a/one', 'a/two'], 'repositoryFile'],
])(
  'refuses %s and names the model, list, and file',
  ([, user, repository, file], { onTestFinished }) => {
    const paths = fixture(onTestFinished, user, repository);
    const resolve = () => resolveAllowedModel(paths.context, 'a/two');

    expect(resolve).toThrow('a/two');
    expect(resolve).toThrow('a/one');
    expect(resolve).toThrow(paths[file]);
  },
);

it('ignores an untrusted repository list and fails loudly on an invalid entry', ({
  onTestFinished,
}) => {
  const { context, userFile } = fixture(onTestFinished, ['a/one', 'a/two'], ['a/one']);

  expect(resolveAllowedModel({ ...context, isProjectTrusted: () => false }, 'a/two')).toEqual({
    provider: 'a',
    id: 'two',
  });

  writeConfig(userFile, ['a/one', 'two']);
  const invalid = () => resolveAllowedModel(context, 'a/one');

  expect(invalid).toThrow(userFile);
  expect(invalid).toThrow('"two"');
});
