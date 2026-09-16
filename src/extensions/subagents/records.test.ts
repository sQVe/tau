import * as fileSystem from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi, onTestFinished as afterTest } from 'vitest';

import * as records from './records.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fileSystem>();

  return {
    ...actual,
    readSync: vi.fn<typeof actual.readSync>(actual.readSync),
    openSync: vi.fn<typeof actual.openSync>(actual.openSync),
    closeSync: vi.fn<typeof actual.closeSync>(actual.closeSync),
    statSync: vi.fn<typeof actual.statSync>(actual.statSync),
  };
});

afterEach(() => vi.resetAllMocks());

it('bounds serialized UTF-8 records including the trailing newline before publication', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const value = { text: '界'.repeat(42_660) };
  value.text += 'x'.repeat(128_000 - Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8'));

  records.publish(directory, 'record.json', value);
  expect(records.readRecord(directory, 'record.json')).toEqual(value);
  expect(readFileSync(join(directory, 'record.json'))).toHaveLength(128_000);
  expect(() => {
    records.publish(directory, 'oversized.json', { text: `${value.text}x` });
  }).toThrow('Worker record exceeds 128 KB.');
  expect(readdirSync(directory)).toEqual(['record.json']);
  expect(records.readRecord(directory, 'record.json')).toEqual(value);
});

it('reads records across short descriptor reads', async ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'record.json'), '{"text":"short read"}');
  const actual = await vi.importActual<typeof fileSystem>('node:fs');
  vi.mocked(fileSystem.readSync).mockImplementation((descriptor, buffer, options) => {
    return actual.readSync(descriptor, buffer, {
      ...options,
      length: Math.min(3, options?.length ?? buffer.byteLength),
    });
  });

  expect(records.readRecord(directory, 'record.json')).toEqual({ text: 'short read' });
  expect(fileSystem.readSync).toHaveBeenCalledTimes(8);
  expect(fileSystem.closeSync).toHaveBeenCalledWith(
    vi.mocked(fileSystem.openSync).mock.results.at(-1)?.value,
  );
});

it('bounds descriptor reads when a record grows during reading', async ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'record.json');
  writeFileSync(path, '{"text":"small"}');
  const actual = await vi.importActual<typeof fileSystem>('node:fs');
  const grow = () => {
    writeFileSync(path, JSON.stringify({ text: 'x'.repeat(256_000) }));
  };
  vi.mocked(fileSystem.statSync).mockImplementationOnce((...arguments_) => {
    const result = actual.statSync(...arguments_);
    grow();

    return result;
  });
  let totalRead = 0;
  vi.mocked(fileSystem.readSync).mockImplementation((descriptor, buffer, options) => {
    const count = actual.readSync(descriptor, buffer, {
      ...options,
      length: Math.min(64_000, options?.length ?? buffer.byteLength),
    });
    if (totalRead === 0) {
      grow();
    }
    totalRead += count;

    return count;
  });

  expect(() => records.readRecord(directory, 'record.json')).toThrow(
    'Worker record exceeds 128 KB.',
  );
  expect(totalRead).toBe(128_001);
  expect(fileSystem.openSync).toHaveBeenCalledTimes(1);
  expect(fileSystem.closeSync).toHaveBeenCalledWith(
    vi.mocked(fileSystem.openSync).mock.results[0]?.value,
  );
});

it.each(['invalid JSON', 'read failure'])('closes the record descriptor after %s', (failure) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  afterTest(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'record.json'), '{');
  if (failure === 'read failure') {
    vi.mocked(fileSystem.readSync).mockImplementationOnce(() => {
      throw new Error('Injected read failure');
    });
  }

  expect(() => records.readRecord(directory, 'record.json')).toThrow(
    failure === 'read failure' ? 'Injected read failure' : /JSON|property/,
  );
  expect(fileSystem.closeSync).toHaveBeenCalledWith(
    vi.mocked(fileSystem.openSync).mock.results[0]?.value,
  );
});

it('keeps report and event publication within their existing byte limits', ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-size-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const report = {
    taskId: 'task-one',
    outcome: 'success',
    summary: '界'.repeat(32_000),
    evidence: [],
  };

  expect(() => records.acceptReport(directory, 'task-one', report)).toThrow(
    'Invalid, oversized, or wrong-task report.',
  );
  expect(() => {
    records.recordEvent(directory, '界'.repeat(32_000), 'ready', '界'.repeat(32_000));
  }).toThrow('Worker record exceeds 128 KB.');
  expect(readdirSync(directory)).toEqual([]);

  const accepted = { ...report, summary: '界'.repeat(10_000) };
  records.acceptReport(directory, 'task-one', accepted);
  records.recordEvent(directory, 'task-one', 'ready', accepted.summary);
  expect(records.readReport(directory, 'task-one')).toEqual(accepted);
  expect(records.readEvent(directory, 'task-one', 'ready')?.detail).toBe(accepted.summary);
});

it('rejects oversized Unicode reports during recovery without replacing evidence', ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-report-recovery-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const report = {
    taskId: 'task-one',
    outcome: 'success',
    summary: '界'.repeat(22_000),
    evidence: [],
  };
  records.publish(directory, 'report.json', report);
  const original = readFileSync(join(directory, 'report.json'), 'utf8');

  expect(Buffer.byteLength(original)).toBeGreaterThan(64_000);
  expect(Buffer.byteLength(original)).toBeLessThan(128_000);
  expect(() => records.readReport(directory, 'task-one')).toThrow('Invalid saved worker report.');
  expect(readFileSync(join(directory, 'report.json'), 'utf8')).toBe(original);
});

it('accepts one validated report without replacing durable evidence', ({ onTestFinished }) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-worker-records-'));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const report = {
    taskId: 'task-one',
    outcome: 'success',
    summary: 'Checked source.',
    evidence: ['source.ts:1'],
  };

  expect(records).toHaveProperty('acceptReport');
  records.acceptReport(directory, 'task-one', report);
  const accepted = readFileSync(join(directory, 'report.json'), 'utf8');

  expect(() => records.acceptReport(directory, 'task-one', report)).toThrow('EEXIST');
  expect(() => records.acceptReport(directory, 'task-one', { ...report, taskId: 'wrong' })).toThrow(
    'Invalid',
  );
  expect(() => records.acceptReport(directory, 'task-one', { taskId: 'task-one' })).toThrow(
    'Invalid',
  );
  expect(() =>
    records.acceptReport(directory, 'task-one', { ...report, summary: 'x'.repeat(40_000) }),
  ).toThrow('Invalid');
  expect(readFileSync(join(directory, 'report.json'), 'utf8')).toBe(accepted);
});
