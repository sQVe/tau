import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, expect, it, vi } from 'vitest';

import * as checker from './checker.js';

vi.mock('node:child_process', async (importOriginal) => {
  const native = await importOriginal<typeof childProcess>();

  return { ...native, spawn: vi.fn<typeof native.spawn>(native.spawn) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('bounds output from a real noisy checker with an explicit truncation notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-noisy-checker-'));

  try {
    const result = await checker.runChecker(
      [
        process.execPath,
        '-e',
        'process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 65)); process.stderr.write(Buffer.alloc(4 * 1024 * 1024, 66));',
      ],
      root,
    );

    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024 + 100);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024 * 1024 + 100);
    expect(result.stdout).toMatch(/output truncated/);
    expect(result.stderr).toMatch(/output truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('drains trailing stdout and stderr after the child exit event', async () => {
  // oxlint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses the Node EventEmitter API.
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.spyOn(childProcess, 'spawn').mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.emit('exit', 0, null);
      setTimeout(() => {
        child.stdout.end(Buffer.from('late stdout é'));
        child.stderr.end(Buffer.from('late stderr é'));
      }, 20);
    });

    return child as unknown as ReturnType<typeof childProcess.spawn>;
  });
  const result = await checker.runChecker(['checker'], '/unused');

  expect(result.stdout).toBe('late stdout é');
  expect(result.stderr).toBe('late stderr é');
});

it('keeps inherited Git config pairs while disabling check-time refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-checker-config-'));
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.abbrev');
  vi.stubEnv('GIT_CONFIG_VALUE_0', '12');

  try {
    const result = await checker.runChecker(
      [
        process.execPath,
        '-e',
        "const git = require('node:child_process').execFileSync; process.stdout.write(git('git', ['config', '--get', 'core.abbrev'])); process.stdout.write(git('git', ['config', '--get', 'diff.autoRefreshIndex']));",
      ],
      root,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('12\nfalse\n');
    expect(process.env.GIT_CONFIG_COUNT).toBe('1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cancels a cooperative checker group before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-checker-'));
  const controller = new AbortController();
  const run = Reflect.get(checker, 'runChecker') as (
    command: string[],
    root: string,
    signal: AbortSignal,
  ) => Promise<{ killed: boolean }>;

  try {
    expect(run).toBeTypeOf('function');
    const execution = run(
      [
        process.execPath,
        '-e',
        `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      process.on('SIGTERM', () => child.once('exit', () => process.exit(0)));
      fs.writeFileSync('ready', String(child.pid));
      setInterval(() => {}, 1000);
    `,
      ],
      root,
      controller.signal,
    );
    let child = '';

    for (let attempt = 0; attempt < 100 && !child; attempt += 1) {
      child = await readFile(join(root, 'ready'), 'utf8').catch(() => '');
      await delay(10);
    }

    expect(child).not.toBe('');
    controller.abort();
    expect(await execution).toMatchObject({ killed: true });
    expect(() => process.kill(Number(child), 0)).toThrow(/ESRCH/);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});
