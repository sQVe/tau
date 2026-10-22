import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readTauConfig,
  readUserOnlyKey,
  userConfigPath,
  warnUnknownTopLevelKeys,
} from './config.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tau-config-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const location = () => ({ cwd: directory, agentDirectory: directory, projectTrusted: false });

const fakeUi = () => {
  const messages: string[] = [];

  return { messages, notify: (message: string) => void messages.push(message) };
};

const writeUserFile = (value: unknown): void => {
  writeFileSync(userConfigPath(directory), JSON.stringify(value));
};

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
