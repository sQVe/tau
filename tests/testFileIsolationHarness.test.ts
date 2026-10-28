import { execFile } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { temporaryDirectory } from './temporaryDirectoryHarness.js';

interface CaseFile {
  name: string;
  source: string;
}

interface IsolationCase {
  leak: string;
  files: CaseFile[];
}

interface Report {
  testResults: { name: string; status: string; message: string }[];
}

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repositoryRoot = resolvePath(import.meta.dirname, '..');

const testFile = (body: string[], imports: string[] = []) =>
  [...imports, "import { expect, it, vi } from 'vitest';", ...body].join('\n');

const realModuleFiles = (index: number): CaseFile[] => [
  { name: `value-${index}.ts`, source: "export const value = 'real';" },
  { name: `reader-${index}.ts`, source: `export { value } from './value-${index}.ts';` },
];

const readsRealModule = (index: number): CaseFile => ({
  name: `${index}-c.test.ts`,
  source: testFile(
    ["it('reads the real module', () => { expect(value).toBe('real'); });"],
    [`import { value } from './reader-${index}.ts';`],
  ),
});

// Each case leaks state from one test file and checks it in a later file of the same worker.
const cases: IsolationCase[] = [
  {
    leak: 'a module loaded under vi.mock',
    files: [
      ...realModuleFiles(0),
      {
        name: '0-a.test.ts',
        source: testFile(
          ["it('loads the real module first', () => { expect(value).toBe('real'); });"],
          ["import { value } from './reader-0.ts';"],
        ),
      },
      {
        name: '0-b.test.ts',
        source: testFile(
          [
            "vi.mock(import('./value-0.ts'), () => ({ value: 'mocked' }));",
            "it('loads the module under the mock', () => { expect(value).toBe('mocked'); });",
          ],
          ["import { value } from './reader-0.ts';"],
        ),
      },
      readsRealModule(0),
    ],
  },
  {
    leak: 'a module loaded under vi.doMock',
    files: [
      ...realModuleFiles(1),
      {
        name: '1-b.test.ts',
        source: testFile([
          "vi.doMock('./value-1.ts', () => ({ value: 'mocked' }));",
          "it('loads the module under the mock', async () => {",
          "  const { value } = await import('./reader-1.ts');",
          "  expect(value).toBe('mocked');",
          '});',
        ]),
      },
      readsRealModule(1),
    ],
  },
  {
    leak: 'fs class prototypes spied by vi.mock',
    files: [
      {
        name: '2-b.test.ts',
        source: testFile(
          [
            "vi.mock(import('node:fs'), { spy: true });",
            "it('spies on fs', () => {",
            '  expect(vi.isMockFunction(fs.WriteStream.prototype.write)).toBe(true);',
            '});',
          ],
          ["import * as fs from 'node:fs';"],
        ),
      },
      {
        name: '2-c.test.ts',
        source: testFile(
          [
            "it('sees the real fs prototypes', () => {",
            "  expect(Object.hasOwn(fs.WriteStream.prototype, 'write')).toBe(false);",
            '  expect(vi.isMockFunction(fs.WriteStream.prototype.write)).toBe(false);',
            '});',
          ],
          ["import * as fs from 'node:fs';"],
        ),
      },
    ],
  },
  {
    leak: 'a stubbed environment variable',
    files: [
      {
        name: '3-b.test.ts',
        source: testFile(["it('stubs', () => { vi.stubEnv('TAU_ISOLATION_PROBE', 'leaked'); });"]),
      },
      {
        name: '3-c.test.ts',
        source: testFile([
          "it('sees no stub', () => { expect(process.env.TAU_ISOLATION_PROBE).toBeUndefined(); });",
        ]),
      },
    ],
  },
  {
    leak: 'a stubbed global',
    files: [
      {
        name: '4-b.test.ts',
        source: testFile(["it('stubs', () => { vi.stubGlobal('tauIsolationProbe', 'leaked'); });"]),
      },
      {
        name: '4-c.test.ts',
        source: testFile([
          "it('sees no stub', () => { expect('tauIsolationProbe' in globalThis).toBe(false); });",
        ]),
      },
    ],
  },
  {
    leak: 'fake timers',
    files: [
      {
        name: '5-b.test.ts',
        source: testFile(["it('fakes timers', () => { vi.useFakeTimers(); });"]),
      },
      {
        name: '5-c.test.ts',
        source: testFile([
          "it('sees real timers', () => { expect(vi.isFakeTimers()).toBe(false); });",
        ]),
      },
    ],
  },
];

// One worker without isolation runs the files in name order, so each case's later file shares
// the worker state that its earlier files changed.
const configSource = (directory: string) =>
  [
    'export default {',
    `  root: ${JSON.stringify(directory)},`,
    '  test: {',
    '    isolate: false,',
    '    maxWorkers: 1,',
    `    setupFiles: [${JSON.stringify(join(import.meta.dirname, 'testFileIsolationHarness.ts'))}],`,
    '    sequence: {',
    '      sequencer: class {',
    '        shard(files) { return files; }',
    '        sort(files) { return files.toSorted((a, b) => a.moduleId.localeCompare(b.moduleId)); }',
    '      },',
    '    },',
    '  },',
    '};',
  ].join('\n');

const runNested = (directory: string, reportPath: string) =>
  new Promise<void>((resolve) => {
    // A failing file makes Vitest exit nonzero. The report holds the result of each file.
    execFile(
      join(repositoryRoot, 'node_modules', '.bin', 'vitest'),
      [
        'run',
        '--config',
        join(directory, 'vitest.config.mjs'),
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      { cwd: directory, timeout: 25_000 },
      () => {
        resolve();
      },
    );
  });

let report: Report;

beforeAll(async () => {
  const directory = temporaryDirectory(afterAll, 'tau-file-isolation-');
  const reportPath = join(directory, 'report.json');

  await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'vitest.config.mjs'), configSource(directory));

  for (const file of cases.flatMap((isolationCase) => isolationCase.files)) {
    await writeFile(join(directory, file.name), file.source);
  }

  await runNested(directory, reportPath);
  report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
});

it.for(cases)('keeps $leak from reaching a later test file', ({ files }) => {
  const testFiles = files.filter((file) => file.name.endsWith('.test.ts'));

  const results = testFiles.map((file) => {
    const result = report.testResults.find((entry) => entry.name.endsWith(`/${file.name}`));

    return { file: file.name, status: result?.status, message: result?.message };
  });

  const expected = testFiles.map((file) => ({ file: file.name, status: 'passed', message: '' }));

  expect(results).toEqual(expected);
});
