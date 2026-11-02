import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { runWithEnvironment } from '../src/hc/connect.js';
import { wait } from '../src/hc/hc.js';
import { sessionProcesses, startHcSession } from './hcSessionHarness.js';

// Process checks read /proc, which exists only on Linux.
const onLinux = process.platform === 'linux';

it('runs a terminal with the caller environment and stops its private core', async () => {
  const hc = await startHcSession(onTestFinished);

  const probe = `probe-${randomBytes(6).toString('hex')}`;
  const outputPath = join(hc.root, 'probe-output');

  const terminal = await runWithEnvironment(hc.runtime, {
    argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', outputPath],
    env: { TAU_PROBE: probe },
  });

  await wait(hc.runtime, terminal.address);

  expect(readFileSync(outputPath, 'utf8')).toBe(probe);

  await hc.stop();

  expect(existsSync(hc.root)).toBe(false);
});

it.skipIf(!onLinux)(
  'stops only its private core and keeps a sentinel session running',
  async () => {
    const hc = await startHcSession(onTestFinished);
    const sentinel = await startHcSession(onTestFinished);

    const probe = `probe-${randomBytes(6).toString('hex')}`;
    const outputPath = join(hc.root, 'probe-output');
    const sentinelOutputPath = join(sentinel.root, 'probe-output');

    const terminal = await runWithEnvironment(hc.runtime, {
      argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', outputPath],
      env: { TAU_PROBE: probe },
    });

    await runWithEnvironment(sentinel.runtime, {
      argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', sentinelOutputPath],
      env: { TAU_PROBE: probe },
    });

    await wait(hc.runtime, terminal.address);

    expect(sessionProcesses(hc.session)).not.toEqual([]);
    expect(sessionProcesses(sentinel.session)).not.toEqual([]);

    await hc.stop();

    expect(sessionProcesses(hc.session)).toEqual([]);
    expect(sessionProcesses(sentinel.session)).not.toEqual([]);

    await sentinel.stop();

    expect(sessionProcesses(sentinel.session)).toEqual([]);
    expect(existsSync(sentinel.root)).toBe(false);
  },
);

it.skipIf(!onLinux)(
  'runs a terminal when TMPDIR contains a space and leaves no private core',
  async () => {
    const outer = mkdtempSync(join(tmpdir(), 'tau-hc-space-'));
    const spaceDirectory = join(outer, 'a b');

    mkdirSync(spaceDirectory);

    // Hooks run in reverse order, so the session stops before this hook runs. The session root is
    // inside spaceDirectory, so the outer folder stays while stop keeps the root for live processes.
    onTestFinished(() => {
      vi.unstubAllEnvs();

      if (readdirSync(spaceDirectory).length === 0) {
        rmSync(outer, { recursive: true, force: true });
      }
    });

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
  },
);
