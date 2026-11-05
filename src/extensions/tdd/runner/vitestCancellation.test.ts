import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { fullRun, validReport } from '../fixtures/reportBuilders.js';
import { fakeSpawn, makeDeps, runTests } from '../fixtures/vitestRunner.js';

const fileReads = vi.hoisted(() => ({ read: (_path: string): void => undefined }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    readFile: (async (...readArguments: Parameters<typeof actual.readFile>) => {
      const [path] = readArguments;
      const content = await actual.readFile(...readArguments);

      fileReads.read(typeof path === 'string' ? path : '');

      return content;
    }) as typeof actual.readFile,
  };
});

beforeAll(() => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(afterAll, 'tau-vitest-cancel-agent-'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

it('reports an abort during the report read as cancelled', async () => {
  const controller = new AbortController();

  fileReads.read = (path) => {
    if (path.endsWith('report.json')) {
      controller.abort();
    }
  };

  const result = await runTests(
    { ...fullRun(), signal: controller.signal },
    makeDeps({ spawn: fakeSpawn({ report: validReport }) }),
  );

  expect(result.kind).toBe('cancelled');
});

it('reports a timed-out run as a timeout without reading its report', async () => {
  const reads: string[] = [];

  fileReads.read = (path) => {
    reads.push(path);
  };

  const result = await runTests(
    fullRun(),
    makeDeps({ spawn: fakeSpawn({ report: validReport, timedOut: true }) }),
  );

  expect(result.kind).toBe('timeout');
  expect(reads.filter((path) => path.endsWith('report.json'))).toEqual([]);
});
