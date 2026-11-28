import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { skillTools } from '../../skillTools.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import {
  workerArguments,
  workerCommand,
  workerEnvironment,
  workerExtensionEntries,
} from './workerCommand.js';
import { workerStartMessage } from './workerStart.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const agentDirectory = '/agent';
const sessionFile = '/records/session.jsonl';
const scratchDirectory = '/agent/tmp/ws/3f9a2c1d';
const assignmentFolder = '/agent/tau/checkout/assignments/one';

const environmentFor = (input: NodeJS.ProcessEnv) =>
  workerEnvironment(input, agentDirectory, scratchDirectory, assignmentFolder);

const pi = (directory: string, mode: number) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pi'), '#!/bin/sh\n');
  chmodSync(join(directory, 'pi'), mode);

  return join(directory, 'pi');
};

it.each([
  {
    name: 'drops PWD',
    input: { PWD: '/work' },
    variable: 'PWD',
    expected: undefined,
  },
  {
    name: 'drops OLDPWD',
    input: { OLDPWD: '/elsewhere' },
    variable: 'OLDPWD',
    expected: undefined,
  },
  {
    name: 'drops the manager terminal id',
    input: { HC_TERMINAL_ID: 't1' },
    variable: 'HC_TERMINAL_ID',
    expected: undefined,
  },
  {
    name: 'drops the manager XDG runtime dir',
    input: { XDG_RUNTIME_DIR: '/run/user/1000' },
    variable: 'XDG_RUNTIME_DIR',
    expected: undefined,
  },
  {
    name: 'drops the manager XDG state home',
    input: { XDG_STATE_HOME: '/home/manager/.local/state' },
    variable: 'XDG_STATE_HOME',
    expected: undefined,
  },
  {
    name: 'keeps the manager home',
    input: { HOME: '/home/manager' },
    variable: 'HOME',
    expected: '/home/manager',
  },
  {
    name: 'keeps the manager XDG cache home',
    input: { XDG_CACHE_HOME: '/home/manager/.cache' },
    variable: 'XDG_CACHE_HOME',
    expected: '/home/manager/.cache',
  },
  {
    name: 'keeps PATH from the manager',
    input: { PATH: '/bin' },
    variable: 'PATH',
    expected: '/bin',
  },
  {
    name: 'sets TAU_ROLE to worker',
    input: { TAU_ROLE: 'manager' },
    variable: 'TAU_ROLE',
    expected: 'worker',
  },
  {
    name: 'sets PI_CODING_AGENT_DIR to the agent directory',
    input: { PI_CODING_AGENT_DIR: '/other' },
    variable: 'PI_CODING_AGENT_DIR',
    expected: agentDirectory,
  },
])('$name', ({ input, variable, expected }) => {
  expect(environmentFor(input)[variable]).toBe(expected);
});

it('gives the worker its scratch folder as TMPDIR, TMP, and TEMP', () => {
  const environment = environmentFor({ TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' });

  expect([environment.TMPDIR, environment.TMP, environment.TEMP]).toEqual([
    scratchDirectory,
    scratchDirectory,
    scratchDirectory,
  ]);
});

it('gives the worker its assignment folder', () => {
  const environment = environmentFor({ TAU_ASSIGNMENT_DIRECTORY: '/manager/assignment' });

  expect(environment.TAU_ASSIGNMENT_DIRECTORY).toBe(assignmentFolder);
});

it('passes no lead-only tool to a worker that loads the slice skill', () => {
  const commandLine = workerArguments(
    sessionFile,
    { ...fixtureLoadout('/tmp'), skills: ['/skills/slice/SKILL.md'] },
    [],
    skillTools,
  );

  const toolsValue = commandLine[commandLine.indexOf('--tools') + 1] ?? '';
  const tools = toolsValue.split(',');

  expect(tools).toContain('slice');
  expect(tools).not.toContain('architect');
});

it('starts the worker without waiting for an approval prompt', () => {
  expect(workerArguments(sessionFile, fixtureLoadout('/tmp'), [], skillTools)).toContain(
    '--approve',
  );
});

it('ends the Pi arguments with the start message after the extension flags', () => {
  const trailingArguments = workerArguments(
    sessionFile,
    fixtureLoadout('/tmp'),
    [{ path: '/ext/package.ts' }],
    skillTools,
  ).slice(-3);

  expect(trailingArguments).toEqual(['-e', '/ext/package.ts', workerStartMessage]);
});

it('loads every built-in extension entry point behind an -e flag', () => {
  const commandLine = workerArguments(sessionFile, fixtureLoadout('/tmp'), [], skillTools);

  for (const entry of workerExtensionEntries()) {
    expect(commandLine[commandLine.indexOf(entry) - 1]).toBe('-e');
  }
});

it('loads the inbox extension without saved Tau settings', () => {
  const commandLine = workerArguments(sessionFile, fixtureLoadout('/tmp'), [], skillTools);
  const inboxPath = fileURLToPath(new URL('../inbox/inbox.ts', import.meta.url));

  expect(commandLine[commandLine.indexOf(inboxPath) - 1]).toBe('-e');
});

it('loads the tool result redaction extension before the bash guard', () => {
  const commandLine = workerArguments(sessionFile, fixtureLoadout('/tmp'), [], skillTools);

  const redactionPath = fileURLToPath(
    new URL('../toolResultRedaction/toolResultRedaction.ts', import.meta.url),
  );

  const guardPath = fileURLToPath(new URL('./workerBashGuard.ts', import.meta.url));
  const redactionIndex = commandLine.indexOf(redactionPath);

  const guardIndex = commandLine.indexOf(guardPath);

  expect(commandLine[redactionIndex - 1]).toBe('-e');
  expect(commandLine[guardIndex - 1]).toBe('-e');
  expect(redactionIndex).toBeLessThan(guardIndex);
});

it('loads the verification record extension in every worker', () => {
  const commandLine = workerArguments(sessionFile, fixtureLoadout('/tmp'), [], skillTools);
  const recordPath = fileURLToPath(new URL('../verification/workerRecord.ts', import.meta.url));

  expect(commandLine[commandLine.indexOf(recordPath) - 1]).toBe('-e');
});

it('passes the session file after --session', () => {
  const leadingArguments = workerArguments(
    sessionFile,
    fixtureLoadout('/tmp'),
    [],
    skillTools,
  ).slice(0, 3);

  expect(leadingArguments).toEqual(['--approve', '--session', sessionFile]);
});

it('runs the first executable pi found on PATH', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  pi(join(root, 'plain'), 0o644);
  const executable = pi(join(root, 'bin'), 0o755);

  vi.stubEnv('PATH', [join(root, 'missing'), join(root, 'plain'), join(root, 'bin')].join(':'));

  expect(workerCommand(sessionFile, fixtureLoadout(root), [], skillTools)[0]).toBe(executable);
});

it('skips a directory named pi on PATH', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  mkdirSync(join(root, 'folder', 'pi'), { recursive: true });
  const executable = pi(join(root, 'bin'), 0o755);

  vi.stubEnv('PATH', [join(root, 'folder'), join(root, 'bin')].join(':'));

  expect(workerCommand(sessionFile, fixtureLoadout(root), [], skillTools)[0]).toBe(executable);
});

it('fails when PATH holds no executable pi', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  pi(join(root, 'plain'), 0o644);

  vi.stubEnv('PATH', join(root, 'plain'));

  expect(() => workerCommand(sessionFile, fixtureLoadout(root), [], skillTools)).toThrow(
    'No pi executable found on PATH.',
  );
});

it('ignores a relative PATH entry', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  const directory = join(root, 'bin');
  pi(directory, 0o755);

  vi.stubEnv('PATH', relative(process.cwd(), directory));

  expect(() => workerCommand(sessionFile, fixtureLoadout(root), [], skillTools)).toThrow(
    'No pi executable found on PATH.',
  );
});
