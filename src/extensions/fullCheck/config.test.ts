import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import type { ConfigWarnings } from '../../tauConfig.js';
import { readFullCheckArgv } from './config.js';

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-full-check-config-'));
  const agentDirectory = join(directory, 'agent');
  const userFile = join(agentDirectory, 'tau.json');

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(agentDirectory);

  return {
    location: { cwd: directory, agentDirectory, projectTrusted: true },
    userFile,
    write: (value: unknown) => {
      writeFileSync(userFile, JSON.stringify(value));
    },
  };
};

const ui = { notify: () => undefined };

it('reads the command for the current repository', () => {
  const { location, write } = fixture();

  write({ fullCheck: { repositories: { 'sQVe/tau': { argv: ['pnpm', 'check'] } } } });

  expect(readFullCheckArgv(location, ui, 'sqve/tau')).toEqual(['pnpm', 'check']);
  expect(readFullCheckArgv(location, ui, 'sQVe/other')).toBeUndefined();
  expect(readFullCheckArgv(location, ui, undefined)).toBeUndefined();
});

it('warns once about an unknown key at any depth and still reads the command', () => {
  const { location, write, userFile } = fixture();
  const notify = vi.fn<ConfigWarnings['notify']>();
  const session = { notify };

  write({
    fullCheck: {
      future: 1,
      repositories: { 'sQVe/tau': { argv: ['pnpm', 'check'], timeout: 5 } },
    },
  });

  expect(readFullCheckArgv(location, session, 'sQVe/tau')).toEqual(['pnpm', 'check']);
  expect(readFullCheckArgv(location, session, 'sQVe/tau')).toEqual(['pnpm', 'check']);

  const messages = notify.mock.calls.map(([message]) => message);

  expect(messages).toHaveLength(2);
  expect(messages.join('\n')).toContain(userFile);
  expect(messages.join('\n')).toContain('fullCheck.future');
  expect(messages.join('\n')).toContain('fullCheck.repositories.sQVe/tau.timeout');
});

it('ignores a bad entry for another repository', () => {
  const { location, write } = fixture();

  write({
    fullCheck: {
      repositories: { 'sQVe/other': { argv: [] }, 'sQVe/tau': { argv: ['pnpm', 'check'] } },
    },
  });

  expect(readFullCheckArgv(location, ui, 'sQVe/tau')).toEqual(['pnpm', 'check']);
});

it.each([
  { name: 'empty argv', argv: [] },
  { name: 'empty string', argv: ['pnpm', ''] },
  { name: 'non-string', argv: ['pnpm', 1] },
  { name: 'string', argv: 'pnpm check' },
])('fails a bad entry for the current repository: $name', ({ argv }) => {
  const { location, write, userFile } = fixture();

  write({ fullCheck: { repositories: { 'sQVe/tau': { argv } } } });

  expect(() => readFullCheckArgv(location, ui, 'sQVe/tau')).toThrow(
    `Invalid Tau config ${userFile}: fullCheck.repositories.sQVe/tau.argv`,
  );
});

it('fails two keys that name the current repository', () => {
  const { location, write } = fixture();

  write({
    fullCheck: {
      repositories: { 'sQVe/tau': { argv: ['a'] }, 'sqve/TAU': { argv: ['b'] } },
    },
  });

  expect(() => readFullCheckArgv(location, ui, 'sqve/tau')).toThrow('Keep one');
});

it('ignores two keys that name another repository', () => {
  const { location, write } = fixture();

  write({
    fullCheck: {
      repositories: {
        'sQVe/other': { argv: ['a'] },
        'sqve/OTHER': { argv: ['b'] },
        'sQVe/tau': { argv: ['pnpm', 'check'] },
      },
    },
  });

  expect(readFullCheckArgv(location, ui, 'sQVe/tau')).toEqual(['pnpm', 'check']);
});

it('gives no command when the user file has no fullCheck key', () => {
  const { location, write } = fixture();

  write({ other: 1 });

  expect(readFullCheckArgv(location, ui, 'sQVe/tau')).toBeUndefined();
});

it('gives no command when the user file does not exist', () => {
  const { location } = fixture();

  expect(readFullCheckArgv(location, ui, 'sQVe/tau')).toBeUndefined();
});

it('gives no command when fullCheck has no repositories', () => {
  const { location, write } = fixture();

  write({ fullCheck: {} });

  expect(readFullCheckArgv(location, ui, 'sQVe/tau')).toBeUndefined();
});

it.each([
  {
    name: 'fullCheck is not an object',
    value: 'pnpm check',
    message: 'fullCheck must be an object',
  },
  { name: 'fullCheck is null', value: null, message: 'fullCheck must be an object' },
  {
    name: 'repositories is not an object',
    value: { repositories: ['sQVe/tau'] },
    message: 'fullCheck.repositories must be an object',
  },
  {
    name: 'repositories is null',
    value: { repositories: null },
    message: 'fullCheck.repositories must be an object',
  },
  {
    name: 'an entry is not an object',
    value: { repositories: { 'sQVe/tau': 'pnpm check' } },
    message: 'fullCheck.repositories.sQVe/tau must be an object',
  },
  {
    name: 'an entry has no argv',
    value: { repositories: { 'sQVe/tau': {} } },
    message: 'fullCheck.repositories.sQVe/tau.argv',
  },
])('fails when $name', ({ value, message }) => {
  const { location, write } = fixture();

  write({ fullCheck: value });

  expect(() => readFullCheckArgv(location, ui, 'sQVe/tau')).toThrow(message);
});
