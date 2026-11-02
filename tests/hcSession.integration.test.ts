import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { runWithEnvironment } from '../src/hc/connect.js';
import { wait } from '../src/hc/hc.js';
import { startHcSession } from './hcSession.js';

interface ServerStatus {
  pid: number;
}

// hc server stop returns once the core has exited, but its parent may not have reaped it yet. A
// zombie still answers signal 0, yet it cannot serve the socket or write files.
const coreIsRunning = (pid: number): boolean => {
  let status: string;

  try {
    process.kill(pid, 0);
    status = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return false;
  }

  const state = status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3);

  return state !== 'Z';
};

it('runs a terminal with the caller environment and stops only its private core', async () => {
  const hc = await startHcSession();
  let stopped = false;

  try {
    const probe = `probe-${randomBytes(6).toString('hex')}`;
    const outputPath = join(hc.root, 'probe-output');

    const terminal = await runWithEnvironment(hc.runtime, {
      argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', outputPath],
      env: { TAU_PROBE: probe },
    });

    await wait(hc.runtime, terminal.address);

    expect(readFileSync(outputPath, 'utf8')).toBe(probe);

    const status = await hc.runtime.exec('hc', ['server', 'status', '--json'], { cwd: hc.root });
    const { pid } = JSON.parse(status.stdout) as ServerStatus;

    expect(typeof pid).toBe('number');
    expect(coreIsRunning(pid)).toBe(true);

    await hc.stop();
    stopped = true;

    expect(coreIsRunning(pid)).toBe(false);
    expect(existsSync(hc.root)).toBe(false);
  } finally {
    if (!stopped) {
      await hc.stop().catch(() => undefined);
    }
  }
});

it('runs a terminal when TMPDIR contains a space and leaves no private core', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'tau-hc-space-'));
  const spaceDirectory = join(outer, 'a b');

  mkdirSync(spaceDirectory);
  vi.stubEnv('TMPDIR', spaceDirectory);

  let hc: Awaited<ReturnType<typeof startHcSession>> | undefined;
  let stopped = false;

  try {
    hc = await startHcSession();

    const probe = `probe-${randomBytes(6).toString('hex')}`;
    const outputPath = join(hc.root, 'probe-output');

    const terminal = await runWithEnvironment(hc.runtime, {
      argv: ['sh', '-c', 'printf %s "$TAU_PROBE" > "$1"', 'sh', outputPath],
      env: { TAU_PROBE: probe },
    });

    await wait(hc.runtime, terminal.address);

    expect(readFileSync(outputPath, 'utf8')).toBe(probe);

    const status = await hc.runtime.exec('hc', ['server', 'status', '--json'], { cwd: hc.root });
    const { pid } = JSON.parse(status.stdout) as ServerStatus;

    await hc.stop();
    stopped = true;

    expect(coreIsRunning(pid)).toBe(false);
    expect(existsSync(hc.root)).toBe(false);
  } finally {
    if (hc !== undefined && !stopped) {
      await hc.stop().catch(() => undefined);
    }

    vi.unstubAllEnvs();
    rmSync(outer, { recursive: true, force: true });
  }
});
