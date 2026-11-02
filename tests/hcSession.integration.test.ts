import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { runWithEnvironment } from '../src/hc/connect.js';
import { wait } from '../src/hc/hc.js';
import { sessionProcesses, startHcSession } from './hcSession.js';

it('runs a terminal with the caller environment and stops only its private core', async () => {
  const hc = await startHcSession(onTestFinished);

  const probe = `probe-${randomBytes(6).toString('hex')}`;
  const outputPath = join(hc.root, 'probe-output');

  const terminal = await runWithEnvironment(hc.runtime, {
    argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', outputPath],
    env: { TAU_PROBE: probe },
  });

  await wait(hc.runtime, terminal.address);

  expect(readFileSync(outputPath, 'utf8')).toBe(probe);
  expect(sessionProcesses(hc.session)).not.toEqual([]);

  await hc.stop();

  expect(sessionProcesses(hc.session)).toEqual([]);
  expect(existsSync(hc.root)).toBe(false);
});

it('runs a terminal when TMPDIR contains a space and leaves no private core', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'tau-hc-space-'));
  const spaceDirectory = join(outer, 'a b');

  // Hooks run in reverse order, so the session stops before its parent folder is removed.
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(outer, { recursive: true, force: true });
  });

  mkdirSync(spaceDirectory);
  vi.stubEnv('TMPDIR', spaceDirectory);

  const hc = await startHcSession(onTestFinished);

  const probe = `probe-${randomBytes(6).toString('hex')}`;
  const outputPath = join(hc.root, 'probe-output');

  const terminal = await runWithEnvironment(hc.runtime, {
    argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', outputPath],
    env: { TAU_PROBE: probe },
  });

  await wait(hc.runtime, terminal.address);

  expect(readFileSync(outputPath, 'utf8')).toBe(probe);
  expect(sessionProcesses(hc.session)).not.toEqual([]);

  await hc.stop();

  expect(sessionProcesses(hc.session)).toEqual([]);
  expect(existsSync(hc.root)).toBe(false);
});
