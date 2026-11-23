import { describe, expect, it } from 'vitest';

import { temporaryTauConfig } from '../../tests/tauConfigHarness.js';
import { readTauConfig, readUserOnlyKey, warnUnknownTopLevelKeys } from './config.js';

const fakeUi = () => {
  const messages: string[] = [];

  return { messages, notify: (message: string) => void messages.push(message) };
};

describe('readTauConfig', () => {
  it.for<{ value: unknown; kind: string }>([
    { value: [], kind: 'array' },
    { value: null, kind: 'null' },
    { value: 5, kind: 'number' },
    { value: 'x', kind: 'string' },
    { value: true, kind: 'boolean' },
  ])(
    'rejects a user file that is not an object (found $kind)',
    ({ value, kind }, { onTestFinished }) => {
      const { location, userFile, writeUser } = temporaryTauConfig(onTestFinished, 'tau-config-');

      writeUser(value);

      expect(() => readTauConfig(location)).toThrow(
        `Invalid Tau config ${userFile}: not a JSON object (found ${kind}).`,
      );
    },
  );

  it('rejects a trusted repository file that is not an object', ({ onTestFinished }) => {
    const { location, repositoryFile, writeRepository } = temporaryTauConfig(
      onTestFinished,
      'tau-config-',
    );

    writeRepository([]);

    expect(() => readTauConfig(location)).toThrow(
      `Invalid Tau config ${repositoryFile}: not a JSON object (found array).`,
    );
  });

  it('ignores an untrusted repository file that is not an object', ({ onTestFinished }) => {
    const { location, repositoryFile, writeRepository } = temporaryTauConfig(
      onTestFinished,
      'tau-config-',
    );

    writeRepository([]);

    expect(readTauConfig({ ...location, projectTrusted: false })).toEqual({
      files: [],
      ignored: repositoryFile,
    });
  });

  it('accepts an empty object', ({ onTestFinished }) => {
    const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-config-');
    const ui = fakeUi();

    writeUser({});
    const { files } = readTauConfig(location);

    expect(files).toHaveLength(1);
    expect(files[0]?.value).toEqual({});

    warnUnknownTopLevelKeys(ui, files);

    expect(ui.messages).toEqual([]);
  });
});

describe('warnUnknownTopLevelKeys', () => {
  it('warns once per session for an unknown key and names the file', ({ onTestFinished }) => {
    const { location, userFile, writeUser } = temporaryTauConfig(onTestFinished, 'tau-config-');
    const ui = fakeUi();

    writeUser({ tddd: {} });

    warnUnknownTopLevelKeys(ui, readTauConfig(location).files);
    warnUnknownTopLevelKeys(ui, readTauConfig(location).files);

    expect(ui.messages).toHaveLength(1);
    expect(ui.messages[0]).toContain(userFile);
    expect(ui.messages[0]).toContain(': tddd ');
  });

  it('does not warn about listed keys, including slice', ({ onTestFinished }) => {
    const { location, writeUser } = temporaryTauConfig(onTestFinished, 'tau-config-');
    const ui = fakeUi();

    writeUser({ tdd: {}, slice: 'AI', tracker: {}, allowedModels: [] });

    warnUnknownTopLevelKeys(ui, readTauConfig(location).files);

    expect(ui.messages).toEqual([]);
  });
});

describe('readUserOnlyKey', () => {
  it('throws for a key missing from topLevelKeys', ({ onTestFinished }) => {
    const { location } = temporaryTauConfig(onTestFinished, 'tau-config-');

    expect(() => readUserOnlyKey(location, 'tddd')).toThrow(/missing from topLevelKeys/);
  });
});
