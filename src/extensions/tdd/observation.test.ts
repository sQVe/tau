import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, it, onTestFinished as registerCleanup, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { createTestObservation } from './observation.js';
import { runTests } from './runner/index.js';
import type { RunnerResult } from './runner/types.js';

vi.mock('./runner/index.js', () => ({ runTests: vi.fn<typeof runTests>() }));

const behavior = { behavior: 'value', testFullName: 'value works', files: ['value.test.ts'] };
const result = (status: 'passed' | 'failed', fullname = 'value works'): RunnerResult => {
  const tests = [{ file: 'value.test.ts', fullname, status }];

  return status === 'passed'
    ? { kind: 'pass', tests }
    : { kind: 'fail', tests, failures: [], truncated: false };
};

const setup = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-observation-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));

  await writeFile(join(cwd, 'value.test.ts'), 'test');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'before');

  return { cwd, observation: createTestObservation(cwd) };
};

beforeEach(() => {
  vi.mocked(runTests).mockReset();
  vi.mocked(runTests).mockResolvedValue(result('passed'));
});

it('saves stale input fingerprints and preserves the outcome when the run record cannot be saved', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);
  const directory = join(cwd, 'diagnostics');

  await mkdir(directory);
  vi.mocked(runTests).mockImplementationOnce(async () => {
    await writeFile(join(cwd, 'src/value.ts'), 'changed during tests');

    return {
      ...result('passed'),
      diagnostics: { directory, durationMs: 10, timeoutMs: 30_000, exitCode: 0 },
    };
  });
  const stale = await observation.run(behavior, 'full');
  const record: unknown = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));

  expect(stale).toMatchObject({ kind: 'pass', freshness: 'stale' });
  expect(stale.inputs.before).not.toBe(stale.inputs.after);
  expect(record).toMatchObject({ cwd, scope: 'full', freshness: 'stale', inputs: stale.inputs });

  const existing = await readFile(join(directory, 'run.json'), 'utf8');
  vi.mocked(runTests).mockResolvedValueOnce({
    ...result('passed'),
    diagnostics: { directory, durationMs: 10, timeoutMs: 30_000, exitCode: 0 },
  });
  const passed = await observation.run(behavior, 'full');

  expect(passed).toMatchObject({ kind: 'pass', freshness: 'fresh' });
  expect(passed.runPath).toBeUndefined();
  expect(passed.report.diagnostics?.error).toContain('Could not save run.json');
  expect(await readFile(join(directory, 'run.json'), 'utf8')).toBe(existing);
});

it('rejects nonliteral test selection before running tests', async ({ onTestFinished }) => {
  const { observation } = await setup(onTestFinished);

  await expect(observation.run({ ...behavior, files: ['*.test.ts'] }, 'focused')).rejects.toThrow(
    'Expected a test file',
  );
  expect(runTests).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')(
  'does not reinterpret POSIX literal backslashes as separators',
  async ({ onTestFinished }) => {
    const { cwd, observation } = await setup(onTestFinished);
    await writeFile(join(cwd, 'tests\\value.test.ts'), 'literal backslash filename');

    await expect(
      observation.run({ ...behavior, files: ['tests\\value.test.ts'] }, 'focused'),
    ).rejects.toThrow('Expected a test file');
    expect(runTests).not.toHaveBeenCalled();
  },
);

it('deduplicates missing RED across edits and focused passes until the behavior changes', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);

  expect(await observation.checkpoint(true)).toContain('RED');
  await writeFile(join(cwd, 'src/value.ts'), 'after');
  expect(await observation.checkpoint(true)).toBeUndefined();

  const first = await observation.run(behavior, 'focused');

  expect(first.hint).toContain('RED');
  expect(
    (await observation.run({ ...behavior, behavior: 'new label' }, 'focused')).hint,
  ).toBeUndefined();
  expect(
    (await observation.run({ ...behavior, testFullName: 'another behavior' }, 'focused')).hint,
  ).toContain('RED');
});

it('observes RED, suggests full once, and starts a new cycle after a full pass', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);
  vi.mocked(runTests).mockResolvedValueOnce(result('failed'));

  expect((await observation.run(behavior, 'focused')).hint).toBeUndefined();
  await writeFile(join(cwd, 'src/value.ts'), 'fixed');
  const green = await observation.run(behavior, 'focused');

  expect(green.hint).toContain('scope "full"');
  expect((await observation.run(behavior, 'focused')).hint).toBeUndefined();
  expect((await observation.run(behavior, 'full')).hint).toBeUndefined();
  expect((await observation.run(behavior, 'full')).hint).toBeUndefined();

  await writeFile(join(cwd, 'src/value.ts'), 'next behavior');
  expect(await observation.checkpoint(true)).toContain('stale');
  expect(await observation.checkpoint(true)).toBeUndefined();
  expect((await observation.run(behavior, 'focused')).hint).toContain('RED');
});

it.each(['duplicate', 'skipped', 'missing', 'load error'])(
  'does not observe RED from %s tests',
  async (invalid) => {
    const { observation } = await setup(registerCleanup);
    const failed = result('failed');

    if (!('tests' in failed)) {
      throw new Error('Missing fixture tests');
    }

    const reports: Record<string, RunnerResult> = {
      duplicate: { ...failed, tests: [...failed.tests, ...failed.tests] },
      skipped: {
        ...failed,
        tests: [{ file: 'value.test.ts', fullname: 'value works', status: 'skipped' }],
      },
      missing: { ...failed, tests: [] },
      'load error': {
        kind: 'compile-error',
        message: 'load failed',
        stdout: '',
        stderr: '',
        tests: [],
      },
    };
    vi.mocked(runTests).mockResolvedValueOnce(reports[invalid]!);

    await observation.run(behavior, 'focused');

    expect((await observation.run(behavior, 'focused')).hint).toContain('RED');
  },
);

it('keeps implementation edits quiet after observed focused RED', async ({ onTestFinished }) => {
  const { cwd, observation } = await setup(onTestFinished);
  vi.mocked(runTests).mockResolvedValueOnce(result('failed'));

  await observation.run(behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'implementation');
  expect(await observation.checkpoint(true)).toBeUndefined();
  await writeFile(join(cwd, 'src/value.ts'), 'more implementation');
  expect(await observation.checkpoint(true)).toBeUndefined();
  expect((await observation.run(behavior, 'focused')).hint).toContain('scope "full"');
});

it('retains observed RED through focused GREEN refactoring until a full pass', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);
  vi.mocked(runTests).mockResolvedValueOnce(result('failed'));

  await observation.run(behavior, 'focused');
  expect((await observation.run(behavior, 'focused')).hint).toContain('scope "full"');

  for (const content of ['refactor one', 'refactor two']) {
    await writeFile(join(cwd, 'src/value.ts'), content);
    expect(await observation.checkpoint(false)).toBeUndefined();
    expect(await observation.checkpoint(true)).toBeUndefined();
  }

  expect((await observation.run(behavior, 'focused')).hint).toContain('scope "full"');
  expect((await observation.run(behavior, 'focused')).hint).toBeUndefined();
  await observation.run(behavior, 'full');
  await writeFile(join(cwd, 'src/value.ts'), 'next cycle');
  expect(await observation.checkpoint(true)).toContain('stale');
  expect(await observation.checkpoint(true)).toBeUndefined();
  await writeFile(join(cwd, 'src/value.ts'), 'next behavior');
  expect(await observation.checkpoint(true)).toContain('RED');
  expect(await observation.checkpoint(true)).toBeUndefined();
});

it.each(['timeout', 'cancelled', 'compile-error', 'runner-missing'])(
  'keeps implementation quiet after observed RED and a focused %s',
  async (kind) => {
    const { cwd, observation } = await setup(registerCleanup);
    vi.mocked(runTests).mockResolvedValueOnce(result('failed'));

    await observation.run(behavior, 'focused');
    await writeFile(join(cwd, 'src/value.ts'), 'implementation');
    expect(await observation.checkpoint(true)).toBeUndefined();
    const report = {
      kind,
      message: 'diagnostic',
      tests: [],
      stdout: '',
      stderr: '',
    } as RunnerResult;
    vi.mocked(runTests).mockResolvedValueOnce(report);

    const observed = await observation.run(behavior, 'focused');

    expect(observed).toMatchObject({ kind, freshness: 'fresh', hint: undefined });
    expect(observed.report).toBe(report);
    await writeFile(join(cwd, 'src/value.ts'), 'more implementation');
    expect(await observation.checkpoint(true)).toBeUndefined();
    await writeFile(join(cwd, 'src/value.ts'), 'another implementation');
    expect(await observation.checkpoint(true)).toBeUndefined();

    await mkdir(join(cwd, 'package.json'));
    vi.mocked(runTests).mockResolvedValueOnce(report);
    const unreadable = await observation.run(behavior, 'focused');

    expect(unreadable).toMatchObject({ kind, freshness: 'unknown' });
    expect(unreadable.report).toBe(report);
    expect(unreadable.hint).toContain('unknown');
    expect(await observation.checkpoint(true)).toBeUndefined();
  },
);

it('keeps stale-first after full pass then hints missing RED only after another input change', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);

  await observation.run(behavior, 'full');
  await writeFile(join(cwd, 'src/value.ts'), 'cleanup');
  expect(await observation.checkpoint(true)).toContain('stale');
  expect(await observation.checkpoint(true)).toBeUndefined();
  await writeFile(join(cwd, 'src/value.ts'), 'cleanup');
  expect(await observation.checkpoint(true)).toBeUndefined();
  await writeFile(join(cwd, 'src/value.ts'), 'later work');
  expect(await observation.checkpoint(false)).toBeUndefined();
  expect(await observation.checkpoint(true)).toContain('RED');
  await writeFile(join(cwd, 'src/value.ts'), 'more work');
  expect(await observation.checkpoint(true)).toBeUndefined();
});

it('still hints stale after a focused pass already hinted missing RED', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);

  expect((await observation.run(behavior, 'focused')).hint).toContain('RED');
  await writeFile(join(cwd, 'src/value.ts'), 'later edit');
  expect(await observation.checkpoint(true)).toContain('stale');
  await writeFile(join(cwd, 'src/value.ts'), 'another edit');
  expect(await observation.checkpoint(true)).toBeUndefined();
});

it('records RED when each name fails once across the listed files', async ({ onTestFinished }) => {
  const { cwd, observation } = await setup(onTestFinished);
  const multiple = {
    ...behavior,
    files: ['value.test.ts', 'second.test.ts'],
    testFullName: ['value works', 'second works'],
  };
  await writeFile(join(cwd, 'second.test.ts'), 'test');
  vi.mocked(runTests).mockResolvedValueOnce({
    kind: 'fail',
    failures: [],
    truncated: false,
    tests: [
      { file: 'value.test.ts', fullname: 'value works', status: 'failed' },
      { file: 'second.test.ts', fullname: 'second works', status: 'failed' },
    ],
  });

  await observation.run(multiple, 'focused');

  expect((await observation.run(multiple, 'focused')).hint).toContain('scope "full"');
});

it('does not record RED when a name fails in more than one listed file', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);
  const multiple = { ...behavior, files: ['value.test.ts', 'second.test.ts'] };
  await writeFile(join(cwd, 'second.test.ts'), 'test');
  vi.mocked(runTests).mockResolvedValueOnce({
    kind: 'fail',
    failures: [],
    truncated: false,
    tests: multiple.files.map((file) => ({ file, fullname: 'value works', status: 'failed' })),
  });

  await observation.run(multiple, 'focused');

  expect((await observation.run(multiple, 'focused')).hint).toContain('RED');
});

it('requires every selected name to fail uniquely', async ({ onTestFinished }) => {
  const { observation } = await setup(onTestFinished);
  vi.mocked(runTests).mockResolvedValueOnce(result('failed'));
  const multiple = { ...behavior, testFullName: ['value works', 'second'] };

  await observation.run(multiple, 'focused');

  expect((await observation.run(multiple, 'focused')).hint).toContain('RED');
});

it('does not retain ancient RED when switching away and back', async ({ onTestFinished }) => {
  const { observation } = await setup(onTestFinished);
  vi.mocked(runTests).mockResolvedValueOnce(result('failed'));

  await observation.run(behavior, 'focused');
  await observation.run({ ...behavior, testFullName: 'second' }, 'focused');

  expect((await observation.run(behavior, 'focused')).hint).toContain('RED');
});

it.each([
  'src/value.ts',
  'value.test.ts',
  'package.json',
  'vitest.config.ts',
  'vitest.config.mjs',
  'new.test.ts',
])('detects changed tracked input at checkpoints: %s', async (file) => {
  const { cwd, observation } = await setup(registerCleanup);

  expect(await observation.run(behavior, 'full')).toMatchObject({
    kind: 'pass',
    freshness: 'fresh',
  });
  await writeFile(join(cwd, file), 'changed');
  expect(await observation.checkpoint(false)).toBeUndefined();
  expect(await observation.checkpoint(true)).toContain('stale');
  await writeFile(join(cwd, file), 'changed again');
  expect(await observation.checkpoint(true)).toContain('RED');
  expect(await observation.checkpoint(true)).toBeUndefined();
  expect(await observation.run(behavior, 'full')).toMatchObject({
    kind: 'pass',
    freshness: 'fresh',
  });
  await writeFile(join(cwd, file), 'next change');
  expect(await observation.checkpoint(true)).toContain('stale');
});

it('fingerprints test-support additions, edits, and deletions between and during runs', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);
  const directory = join(cwd, 'tests/fixtures');
  const helper = join(directory, 'helper.ts');

  await mkdir(directory, { recursive: true });
  let previous = await observation.run(behavior, 'full');

  for (const content of ['created', 'edited', undefined]) {
    if (content === undefined) {
      await rm(helper);
    } else {
      await writeFile(helper, content);
    }

    expect(await observation.checkpoint(false)).toBeUndefined();
    expect(await observation.checkpoint(true)).toContain('stale');
    const current = await observation.run(behavior, 'full');

    expect(current).toMatchObject({ kind: 'pass', freshness: 'fresh' });
    expect(current.inputs.before).not.toBeNull();
    expect(current.inputs.before).not.toBe(previous.inputs.after);
    previous = current;
  }

  await writeFile(helper, 'before');
  const report = result('failed');
  vi.mocked(runTests).mockImplementationOnce(async () => {
    await writeFile(helper, 'during run');

    return report;
  });
  const observed = await observation.run(behavior, 'focused');

  expect(observed).toMatchObject({ kind: 'fail', freshness: 'stale' });
  expect(observed.inputs.before).not.toBe(observed.inputs.after);
  expect(observed.report).toBe(report);
});

it('keeps the actual report when inputs change during the run', async ({ onTestFinished }) => {
  const { cwd, observation } = await setup(onTestFinished);
  const report = result('failed');
  vi.mocked(runTests).mockImplementationOnce(async () => {
    await writeFile(join(cwd, 'src/value.ts'), 'during run');

    return report;
  });

  const observed = await observation.run(behavior, 'focused');

  expect(observed).toMatchObject({ kind: 'fail', freshness: 'stale' });
  expect(observed.report).toBe(report);
  expect(observed.hint).toContain('stale');
  expect((await observation.run(behavior, 'focused')).hint).toContain('RED');
});

it('recovers freshness after a transient fingerprint failure', async ({ onTestFinished }) => {
  const { cwd, observation } = await setup(onTestFinished);

  expect((await observation.run(behavior, 'full')).hint).toBeUndefined();
  await mkdir(join(cwd, 'package.json'));
  expect(await observation.checkpoint(true)).toContain('unknown');

  await rm(join(cwd, 'package.json'), { recursive: true });
  expect(await observation.checkpoint(true)).toBeUndefined();
});

it('keeps reports and successful edits when fingerprints fail', async ({ onTestFinished }) => {
  const { cwd, observation } = await setup(onTestFinished);
  const report = result('passed');
  vi.mocked(runTests).mockResolvedValue(report);
  await mkdir(join(cwd, 'package.json'));

  const observed = await observation.run(behavior, 'full');

  expect(observed).toMatchObject({ kind: 'pass', freshness: 'unknown' });
  expect(observed.report).toBe(report);
  expect(observed.hint).toContain('unknown');
  await expect(observation.checkpoint(true)).resolves.toBeUndefined();
});

it.each(['cancelled', 'timeout', 'runner-missing', 'compile-error', 'no-tests-collected'])(
  'preserves runner outcome %s',
  async (kind) => {
    const { observation } = await setup(registerCleanup);
    const report = {
      kind,
      message: 'diagnostic',
      tests: [],
      stdout: '',
      stderr: '',
    } as RunnerResult;
    vi.mocked(runTests).mockResolvedValue(report);

    const observed = await observation.run(behavior, 'full');

    expect(observed.kind).toBe(kind);
    expect(observed.report).toBe(report);
  },
);

it('orders run completion and queued edit checkpoints without marking later edits fresh', async ({
  onTestFinished,
}) => {
  const { cwd, observation } = await setup(onTestFinished);
  const started = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<RunnerResult>();
  vi.mocked(runTests).mockImplementationOnce(() => {
    started.resolve(undefined);

    return finish.promise;
  });

  const running = observation.run(behavior, 'full');
  await started.promise;
  await writeFile(join(cwd, 'src/value.ts'), 'newer edit');
  const checkpoint = observation.checkpoint(true);
  finish.resolve(result('passed'));

  expect(await running).toMatchObject({ kind: 'pass', freshness: 'stale' });
  expect(await checkpoint).toBeUndefined();
  expect((await observation.run(behavior, 'full')).freshness).toBe('fresh');
});

it('isolates observations between directories and extension instances', async ({
  onTestFinished,
}) => {
  const first = await setup(onTestFinished);
  const second = await setup(onTestFinished);
  vi.mocked(runTests).mockResolvedValueOnce(result('failed'));

  await first.observation.run(behavior, 'focused');

  expect(await second.observation.checkpoint(true)).toContain('RED');
  expect(await createTestObservation(first.cwd).checkpoint(true)).toContain('RED');
});
