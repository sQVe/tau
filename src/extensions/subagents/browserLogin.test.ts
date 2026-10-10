import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import type { ConfigWarnings } from '../../tauConfig.js';
import { readBrowserLoginCommand } from './browserLogin.js';

const ui = { notify: () => undefined };

const command = 'google-chrome-stable --profile-directory="Agent profile"';

const configFixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-browser-login-'));
  const agentDirectory = join(directory, 'agent');

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(agentDirectory);
  mkdirSync(join(directory, '.pi'));

  return {
    location: { cwd: directory, agentDirectory, projectTrusted: true },
    writeUser: (value: unknown) => {
      writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(value));
    },
    writeRepository: (value: unknown) => {
      writeFileSync(join(directory, '.pi', 'tau.json'), JSON.stringify(value));
    },
  };
};

it('reads the browser login command from the user file', () => {
  const { location, writeUser } = configFixture();

  writeUser({ browser: { loginCommand: command } });

  expect(readBrowserLoginCommand(location, ui)).toBe(command);
});

it.each([
  { condition: 'the user file is missing', user: undefined },
  { condition: 'browser is not set', user: { profiles: {} } },
  { condition: 'browser has no loginCommand', user: { browser: {} } },
])('reads no browser login command when $condition', ({ user }) => {
  const { location, writeUser } = configFixture();

  if (user !== undefined) {
    writeUser(user);
  }

  expect(readBrowserLoginCommand(location, ui)).toBeUndefined();
});

it.each([
  { condition: 'browser is not an object', browser: command, error: 'browser must be an object' },
  { condition: 'the command is not a string', browser: { loginCommand: 1 }, error: 'string' },
  { condition: 'the command is empty', browser: { loginCommand: ' ' }, error: 'empty' },
])('refuses a browser login command when $condition', ({ browser, error }) => {
  const { location, writeUser } = configFixture();

  writeUser({ browser });

  expect(() => readBrowserLoginCommand(location, ui)).toThrow(error);
});

it('refuses a browser login command set in a repository file', () => {
  const { location, writeUser, writeRepository } = configFixture();

  writeUser({ browser: { loginCommand: command } });
  writeRepository({ browser: { loginCommand: 'open-project-browser' } });

  expect(() => readBrowserLoginCommand(location, ui)).toThrow('may be set only in the user file');
});

it('reads the browser login command past an unknown key and warns about it', () => {
  const { location, writeUser } = configFixture();
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeUser({ browser: { loginCommand: command, profile: 'Agent profile' } });

  expect(readBrowserLoginCommand(location, { notify })).toBe(command);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('browser.profile'), 'warning');
});

it('warns about browser keys named like Object.prototype members', () => {
  const { location, writeUser } = configFixture();
  const notify = vi.fn<ConfigWarnings['notify']>();

  writeUser({ browser: { loginCommand: command, constructor: 1, toString: 2 } });

  expect(readBrowserLoginCommand(location, { notify })).toBe(command);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('browser.constructor'), 'warning');
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('browser.toString'), 'warning');
});
