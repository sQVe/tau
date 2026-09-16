import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import * as records from './records.js';

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
