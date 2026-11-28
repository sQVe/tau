import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { holdFileLock, readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { sessionLockPath } from '../../../sessionLock/sessionLock.js';
import { appCommands, openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect } from './open.js';

const refusal = (sessionFile: string): string =>
  `The architect session ${sessionFile} is open in another Pi (terminal t-old, pid ${String(process.pid)}). End that Pi once it is idle, then call architect open again.`;

it('refuses to resume a session another live Pi holds', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root);
  const sessionFile = await recordSession(root);

  const lockPath = await sessionLockPath(config.location.agentDirectory, sessionFile);
  const held = await holdFileLock({ lockPath, checkout: '/other', terminal: 't-old' });

  cleanup(async () => {
    if (held.kind === 'held') {
      await held.release();
    }
  });

  const lockDirectory = dirname(lockPath);

  const lockFiles = (): [string, Buffer][] =>
    readdirSync(lockDirectory)
      .toSorted()
      .map((name): [string, Buffer] => [name, readFileSync(join(lockDirectory, name))]);

  const filesBefore = lockFiles();

  await expect(openArchitect(requestFor(root, config.location, runtime))).rejects.toThrow(
    new Error(refusal(sessionFile)),
  );

  expect(appCommands(app)).not.toContain('pane.split');
  expect(appCommands(app)).not.toContain('tab.new');
  expect(hc.calls.map((call) => call.command)).not.toContain('kill');
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(lockFiles()).toEqual(filesBefore);
});

it('resumes the recorded session once its holder releases it', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);
  const sessionFile = await recordSession(root);

  const held = await holdFileLock({
    lockPath: await sessionLockPath(config.location.agentDirectory, sessionFile),
    checkout: '/other',
    terminal: 't-old',
  });

  await expect(openArchitect(requestFor(root, config.location, runtime))).rejects.toThrow(
    new Error(refusal(sessionFile)),
  );

  if (held.kind !== 'held') {
    throw new Error('The test could not hold the session lock.');
  }

  await held.release();

  await expect(openArchitect(requestFor(root, config.location, runtime))).resolves.toEqual({
    status: 'resumed',
    sessionFile,
    model: 'a/architect',
  });
});

it('names a holder that recorded no terminal', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);
  const sessionFile = await recordSession(root);

  const held = await holdFileLock({
    lockPath: await sessionLockPath(config.location.agentDirectory, sessionFile),
    checkout: '/other',
    terminal: undefined,
  });

  cleanup(async () => {
    if (held.kind === 'held') {
      await held.release();
    }
  });

  await expect(openArchitect(requestFor(root, config.location, runtime))).rejects.toThrow(
    new Error(
      `The architect session ${sessionFile} is open in another Pi (no hc terminal, pid ${String(process.pid)}). End that Pi once it is idle, then call architect open again.`,
    ),
  );
});

it('resumes the recorded session when the session has no lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);
  const sessionFile = await recordSession(root);
  const lockPath = await sessionLockPath(config.location.agentDirectory, sessionFile);

  await expect(openArchitect(requestFor(root, config.location, runtime))).resolves.toEqual({
    status: 'resumed',
    sessionFile,
    model: 'a/architect',
  });

  expect(existsSync(join(config.location.agentDirectory, 'tau'))).toBe(false);
  expect(existsSync(lockPath)).toBe(false);
});

it('resumes the recorded session when its highest lock generation is malformed', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);
  const sessionFile = await recordSession(root);
  const lockPath = await sessionLockPath(config.location.agentDirectory, sessionFile);

  const generation = `${lockPath}.1`;

  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(generation, 'not json');

  const bytes = readFileSync(generation);

  await expect(openArchitect(requestFor(root, config.location, runtime))).resolves.toEqual({
    status: 'resumed',
    sessionFile,
    model: 'a/architect',
  });

  expect(readFileSync(generation)).toEqual(bytes);
  expect(readdirSync(dirname(lockPath))).toEqual(['lock.1']);
});
