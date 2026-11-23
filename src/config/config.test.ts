import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import {
  readTauConfig,
  readUserOnlyKey,
  userConfigPath,
  warnUnknownTopLevelKeys,
} from './config.js';

let directory: string;

beforeEach(({ onTestFinished }) => {
  directory = temporaryDirectory(onTestFinished, 'tau-config-');
});

const location = () => ({ cwd: directory, agentDirectory: directory, projectTrusted: false });

const fakeUi = () => {
  const messages: string[] = [];

  return { messages, notify: (message: string) => void messages.push(message) };
};

const writeUserFile = (value: unknown): void => {
  writeFileSync(userConfigPath(directory), JSON.stringify(value));
};

describe('readTauConfig', () => {
  it.for<{ value: unknown; kind: string }>([
    { value: [], kind: 'array' },
    { value: null, kind: 'null' },
    { value: 5, kind: 'number' },
    { value: 'x', kind: 'string' },
    { value: true, kind: 'boolean' },
  ])('rejects a user file that is not an object (found $kind)', ({ value, kind }) => {
    writeUserFile(value);

    expect(() => readTauConfig(location())).toThrow(
      `Invalid Tau config ${userConfigPath(directory)}: not a JSON object (found ${kind}).`,
    );
  });

  it('rejects a trusted repository file that is not an object', () => {
    mkdirSync(join(directory, '.pi'));
    const repositoryPath = join(directory, '.pi', 'tau.json');
    writeFileSync(repositoryPath, '[]');

    expect(() => readTauConfig({ ...location(), projectTrusted: true })).toThrow(
      `Invalid Tau config ${repositoryPath}: not a JSON object (found array).`,
    );
  });

  it('ignores an untrusted repository file that is not an object', () => {
    mkdirSync(join(directory, '.pi'));
    const repositoryPath = join(directory, '.pi', 'tau.json');
    writeFileSync(repositoryPath, '[]');

    expect(readTauConfig(location())).toEqual({ files: [], ignored: repositoryPath });
  });

  it('accepts an empty object', () => {
    writeUserFile({});
    const ui = fakeUi();
    const { files } = readTauConfig(location());

    expect(files).toHaveLength(1);
    expect(files[0]?.value).toEqual({});

    warnUnknownTopLevelKeys(ui, files);

    expect(ui.messages).toEqual([]);
  });
});

describe('warnUnknownTopLevelKeys', () => {
  it('warns once per session for an unknown key and names the file', () => {
    writeUserFile({ tddd: {} });
    const ui = fakeUi();

    warnUnknownTopLevelKeys(ui, readTauConfig(location()).files);
    warnUnknownTopLevelKeys(ui, readTauConfig(location()).files);

    expect(ui.messages).toHaveLength(1);
    expect(ui.messages[0]).toContain(userConfigPath(directory));
    expect(ui.messages[0]).toContain(': tddd ');
  });

  it('does not warn about listed keys, including slice', () => {
    writeUserFile({ tdd: {}, slice: 'AI', tracker: {}, allowedModels: [] });
    const ui = fakeUi();

    warnUnknownTopLevelKeys(ui, readTauConfig(location()).files);

    expect(ui.messages).toEqual([]);
  });
});

describe('readUserOnlyKey', () => {
  it('throws for a key missing from topLevelKeys', () => {
    expect(() => readUserOnlyKey(location(), 'tddd')).toThrow(/missing from topLevelKeys/);
  });
});
