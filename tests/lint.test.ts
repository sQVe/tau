import { spawnSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { expect, it, vi } from 'vitest';

import { readTauArtifactInputs } from '../src/tau/tauArtifact.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const root = fileURLToPath(new URL('../', import.meta.url));

it('rejects lint warnings in project checks', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-lint-');

  const fixture = join(directory, 'warning.js');
  await writeFile(fixture, 'console.log("warning fixture");\n');

  const result = spawnSync('pnpm', ['lint', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('eslint(no-console)');
}, 30_000);

it('runs house style only in the style command and Tau rules in both', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-style-');

  const fixture = join(directory, 'style.ts');

  await writeFile(
    fixture,
    [
      'export const cb = (): number => 1;',
      '',
      "export const missing = (error: { code?: string }): boolean => error.code === 'ENOENT';",
      '',
    ].join('\n'),
  );

  const ordinary = spawnSync('pnpm', ['lint', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const style = spawnSync('pnpm', ['style:check', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(ordinary.error).toBeUndefined();
  expect(ordinary.status).toBe(1);
  expect(ordinary.stdout).toContain('tau(no-enoent-literal)');
  expect(ordinary.stdout).not.toContain('seam(no-abbreviations)');
  expect(style.error).toBeUndefined();
  expect(style.status).toBe(1);
  expect(style.stdout).toContain('tau(no-enoent-literal)');
  expect(style.stdout).toContain('seam(no-abbreviations)');
}, 60_000);

it('keeps size thresholds advisory without weakening other lint checks', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-style-size-');

  const fixture = join(directory, 'large.ts');

  await writeFile(
    fixture,
    [
      'export const sum = (first: number, second: number, third: number, fourth: number, fifth: number): number => first + second + third + fourth + fifth;',
      '',
      'export const longFunction = (values: number[]): void => {',
      ...Array.from({ length: 61 }, () => '  values.push(values.length);'),
      '};',
      '',
      ...Array.from({ length: 501 }, (_, index) => `export const value${index} = ${index};`),
    ].join('\n'),
  );

  const result = spawnSync('pnpm', ['style:check', fixture], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('max-lines');
  expect(result.stdout).not.toContain('max-params');
}, 30_000);

// A temp root inside the checkout would let a fixture write into the real source tree.
const assertOutsideCheckout = (directory: string): void => {
  const relativePath = relative(root, directory);
  const escapes = relativePath.startsWith('..') || isAbsolute(relativePath);
  const inside = relativePath === '' || !escapes;

  if (inside) {
    throw new Error(`The lint fixture temp root ${directory} is inside the checkout.`);
  }
};

const createFixtureRoot = (
  onTestFinished: (cleanup: () => void) => void,
  prefix: string,
): string => {
  const temporaryRoot = resolve(tmpdir());

  assertOutsideCheckout(temporaryRoot);

  return temporaryDirectory(onTestFinished, prefix);
};

// The lint config matches `src/**` below the working directory, so the fixture is its own package
// with the repository config, plugin, helpers, and dependencies linked in. It sits outside the
// checkout, so key calculation on the real tree never sees its files.
const createImportFixture = async (
  onTestFinished: (cleanup: () => void) => void,
): Promise<string> => {
  const directory = createFixtureRoot(onTestFinished, 'tau-lint-imports-');

  await writeFile(join(directory, 'package.json'), '{"name":"tau-lint-imports"}\n');

  for (const name of ['vite.config.ts', 'node_modules', 'tests', 'lint']) {
    await symlink(join(root, name), join(directory, name));
  }

  const packageDirectory = join(directory, 'src');
  const helperPath = join(root, 'tests', 'gitRepository.js');
  const helper = `import { initializeRepository } from '${relative(packageDirectory, helperPath)}';\n`;
  const probe = `${helper}\nexport const value = initializeRepository;\n`;

  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'probe.ts'), probe);
  await writeFile(join(packageDirectory, 'probe.test.ts'), probe);

  return directory;
};

it('refuses a lint fixture temp root inside the checkout', async ({ onTestFinished }) => {
  vi.stubEnv('TMPDIR', join(root, 'src'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await expect(createImportFixture(onTestFinished)).rejects.toThrow(/inside the checkout/u);
});

it('keeps test helpers out of production code', async ({ onTestFinished }) => {
  const directory = await createImportFixture(onTestFinished);

  // A full check may key the real checkout while this fixture exists.
  await expect(readTauArtifactInputs(root)).resolves.toHaveProperty('key');

  // The repository binary runs the linked config without pnpm, which would try to install into
  // the linked node_modules.
  const result = spawnSync(
    join(root, 'node_modules', '.bin', 'vp'),
    ['lint', '--format', 'agent', 'src'],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('no-restricted-imports'));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('src/probe.ts:');
}, 30_000);

const lintModuleBoundaries = (files: string[]) => {
  const result = spawnSync('pnpm', ['lint', '--format', 'agent', ...files], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  const diagnostics = result.stdout
    .split('\n')
    .filter((line) => line.includes('tau(module-boundaries)'));

  return { result, diagnostics };
};

it('fails new shared files and shared imports that the module table does not list', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-modules-');
  await mkdir(join(directory, 'src'));

  const example = join(directory, 'src', 'example.ts');
  const valueImport = join(directory, 'src', 'skillTools.ts');
  const typeImport = join(directory, 'src', 'errors.ts');

  await writeFile(example, 'export const value = 1;\n');

  await writeFile(
    valueImport,
    "import { runGithub } from './github.js';\n\nexport const value = runGithub;\n",
  );

  await writeFile(
    typeImport,
    "import type { Problem } from './schema.js';\n\nexport type Value = Problem;\n",
  );

  const { result, diagnostics } = lintModuleBoundaries([example, valueImport, typeImport]);
  const linesFor = (file: string) => diagnostics.filter((line) => line.includes(file));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(3);
  expect(linesFor(example)[0]).toContain('File "example.ts" is not in a module');
  expect(linesFor(valueImport)[0]).toContain('"skillTools" must not import module "github"');
  expect(linesFor(typeImport)[0]).toContain('"errors" must not import module "schema"');
}, 30_000);

it('keeps extensions out of shared modules, including the package entry', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-modules-');
  await mkdir(join(directory, 'src'));

  const shared = join(directory, 'src', 'skillTools.ts');
  const entry = join(directory, 'src', 'tau.ts');

  const extension =
    "import commit from './extensions/commit/commit.js';\n\nexport default commit;\n";

  await writeFile(shared, extension);
  await writeFile(entry, extension);

  const { result, diagnostics } = lintModuleBoundaries([shared, entry]);
  const linesFor = (file: string) => diagnostics.filter((line) => line.includes(file));

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(2);
  expect(linesFor(shared)[0]).toContain('"skillTools" must not import extension "commit"');
  expect(linesFor(entry)[0]).toContain('"tau" must not import extension "commit"');
}, 30_000);

// The fixture is its own package outside the checkout, so the rule reads its `src/` layout and key
// calculation on the real tree never sees its files.
const createPrivateFixture = async (
  onTestFinished: (cleanup: () => void) => void,
): Promise<string> => {
  const directory = createFixtureRoot(onTestFinished, 'tau-lint-private-');
  const probe = join(directory, 'src', 'extensions', 'subagents', 'probe.ts');

  await writeFile(join(directory, 'package.json'), '{"name":"tau-lint-private"}\n');
  await mkdir(dirname(probe), { recursive: true });

  await writeFile(
    probe,
    [
      "import { launchTiming } from './controller/budget.js';",
      "import { WorkerController } from './controller/controller.js';",
      "import { EvidenceUnavailableError } from './controller/record.js';",
      "import { stopOwnedWorker } from './controller/stop.js';",
      '',
      'export const value = [launchTiming, WorkerController, EvidenceUnavailableError, stopOwnedWorker];',
      '',
    ].join('\n'),
  );

  return probe;
};

it('keeps private controller files out of the rest of the subagents extension', async ({
  onTestFinished,
}) => {
  const probe = await createPrivateFixture(onTestFinished);

  // A full check may key the real checkout while this fixture exists.
  await expect(readTauArtifactInputs(root)).resolves.toHaveProperty('key');

  const { result, diagnostics } = lintModuleBoundaries([probe]);

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('probe.ts:4:1: error tau(module-boundaries)');
  expect(diagnostics[0]).toContain('private file "stop"');
}, 30_000);

it('ignores an unrelated src folder above the project root', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-modules-');

  const project = join(directory, 'src', 'project');
  const files = ['scripts', 'lint', 'tests'].map((folder) => join(project, folder, 'probe.ts'));

  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{}\n');

  for (const file of files) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'export const value = 1;\n');
  }

  const { result, diagnostics } = lintModuleBoundaries(files);

  expect(result.error).toBeUndefined();
  expect(diagnostics).toEqual([]);
}, 30_000);

const styleRulePattern = /\b[a-z][a-z-]*\([a-z][a-z-]*\)/u;

const unusedDirectivePrefixes = [
  'Unused oxlint-disable directive',
  'Unused eslint-disable directive',
];

// The style command prints one line per diagnostic when it has no terminal, and a multi-line block
// with a separate location and help line when it has one. Group each diagnostic so a test can find
// its location and rule id in either form.
const readStyleDiagnostics = (stdout: string): string[] => {
  const lines = stripVTControlCharacters(stdout).split('\n');
  const diagnostics: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }

    diagnostics.push(current.join('\n'));
    current = [];
  };

  for (const line of lines) {
    const startsDiagnostic =
      styleRulePattern.test(line) ||
      unusedDirectivePrefixes.some((prefix) => line.includes(prefix));

    if (startsDiagnostic) {
      flush();
    }

    if (current.length > 0 || startsDiagnostic) {
      current.push(line);
    }
  }

  flush();

  return diagnostics;
};

const runStyleCheck = (directory: string) => {
  const result = spawnSync(
    join(root, 'node_modules', '.bin', 'vp'),
    ['lint', '--deny-warnings', '--format', 'default', '--', directory],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SEAM_STYLE: '1' },
    },
  );

  if (result.error !== undefined) {
    return { result, diagnostics: [] };
  }

  const diagnostics = readStyleDiagnostics(result.stdout);

  return { result, diagnostics };
};

const diagnosticsAt = (diagnostics: string[], fixture: string, line: number): string[] =>
  diagnostics.filter((diagnostic) => diagnostic.includes(`${fixture}:${line}:`));

it('reads one-line and multi-line style diagnostics', () => {
  const oneLine =
    '/tmp/oneLine.ts:1:3: error typescript(ban-ts-comment): Use a description. help: Add a description.';

  const multiLine = [
    '  x typescript(ban-ts-comment): Use a description.',
    '   ,-[/tmp/multiLine.ts:2:3]',
    ' 1 | // @ts-expect-error',
    '   :   ^^^^^^^^^^^^^^^^^',
    ' 2 | export const value: number = "text";',
    '   `----',
    '  help: Add a description.',
  ].join('\n');

  const diagnostics = readStyleDiagnostics(`${oneLine}\n${multiLine}\n`);

  expect(diagnostics).toHaveLength(2);
  expect(diagnostics[0]).toContain('/tmp/oneLine.ts:1:');
  expect(diagnostics[0]).toContain('typescript(ban-ts-comment)');
  expect(diagnostics[0]).toContain('help:');
  expect(diagnostics[1]).toContain('/tmp/multiLine.ts:2:');
  expect(diagnostics[1]).toContain('typescript(ban-ts-comment)');
  expect(diagnostics[1]).toContain('help:');
});

it('fails the real style step on banned markers', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-real-');
  const fixture = join(directory, 'bannedMarkers.test.ts');

  await writeFile(
    fixture,
    [
      "import { describe, it } from 'vitest';",
      '',
      "describe.only('focused suite', () => {});",
      '',
      "it.skip('skipped test', () => {});",
      '',
      '// oxlint-disable-next-line eslint/no-console',
      "console.log('one');",
      '',
      '// @ts-ignore',
      "export const value: number = 'text';",
      '',
    ].join('\n'),
  );

  const result = spawnSync('pnpm', ['style:check', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('vitest(no-focused-tests)');
  expect(result.stdout).toContain('vitest(no-disabled-tests)');
  expect(result.stdout).toContain('seam(require-disable-reason)');
  expect(result.stdout).toContain('typescript(ban-ts-comment)');
}, 30_000);

it('fails focused tests on describe and it', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-focus-');
  const fixture = join(directory, 'focused.test.ts');

  await writeFile(
    fixture,
    [
      "import { describe, it } from 'vitest';",
      '',
      "describe.only('focused suite', () => {});",
      '',
      "it.only('focused test', () => {});",
      '',
    ].join('\n'),
  );

  const { result, diagnostics } = runStyleCheck(directory);

  const focused = diagnostics.filter((diagnostic) =>
    diagnostic.includes('vitest(no-focused-tests)'),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(focused).toHaveLength(2);

  const atLineThree = diagnosticsAt(focused, fixture, 3);
  const atLineFive = diagnosticsAt(focused, fixture, 5);

  expect(atLineThree).toHaveLength(1);
  expect(atLineThree[0]).toContain(`${fixture}:3:`);
  expect(atLineFive).toHaveLength(1);
  expect(atLineFive[0]).toContain(`${fixture}:5:`);

  for (const diagnostic of focused) {
    expect(diagnostic).toContain('help:');
  }
}, 30_000);

it('fails skipped tests on describe and it', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-skip-');
  const fixture = join(directory, 'disabled.test.ts');

  await writeFile(
    fixture,
    [
      "import { describe, it } from 'vitest';",
      '',
      "describe.skip('skipped suite', () => {});",
      '',
      "it.skip('skipped test', () => {});",
      '',
    ].join('\n'),
  );

  const { result, diagnostics } = runStyleCheck(directory);

  const disabled = diagnostics.filter((diagnostic) =>
    diagnostic.includes('vitest(no-disabled-tests)'),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(disabled).toHaveLength(2);

  const atLineThree = diagnosticsAt(disabled, fixture, 3);
  const atLineFive = diagnosticsAt(disabled, fixture, 5);

  expect(atLineThree).toHaveLength(1);
  expect(atLineThree[0]).toContain(`${fixture}:3:`);
  expect(atLineFive).toHaveLength(1);
  expect(atLineFive[0]).toContain(`${fixture}:5:`);

  for (const diagnostic of disabled) {
    expect(diagnostic).toContain('help:');
  }
}, 30_000);

it('fails disable comments without a reason', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-suppress-');
  const fixture = join(directory, 'reasonlessDisable.ts');

  await writeFile(
    fixture,
    [
      '// oxlint-disable-next-line eslint/no-console',
      "console.log('one');",
      '',
      '// eslint-disable-next-line eslint/no-console',
      "console.log('two');",
      '',
    ].join('\n'),
  );

  const { result, diagnostics } = runStyleCheck(directory);

  const reasonless = diagnostics.filter((diagnostic) =>
    diagnostic.includes('seam(require-disable-reason)'),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(reasonless).toHaveLength(2);

  const atLineOne = diagnosticsAt(reasonless, fixture, 1);
  const atLineFour = diagnosticsAt(reasonless, fixture, 4);

  expect(atLineOne).toHaveLength(1);
  expect(atLineOne[0]).toContain(`${fixture}:1:`);
  expect(atLineFour).toHaveLength(1);
  expect(atLineFour[0]).toContain(`${fixture}:4:`);

  for (const diagnostic of reasonless) {
    expect(diagnostic).toContain(' -- ');
  }
}, 30_000);

it('fails unused disable directives at their line', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-unused-');
  const fixture = join(directory, 'unusedDisable.ts');

  await writeFile(
    fixture,
    [
      '// oxlint-disable-next-line eslint/no-console -- The fixture has no console call.',
      '// eslint-disable-next-line eslint/no-console -- The fixture has no console call.',
      'export const value = 1;',
      '',
    ].join('\n'),
  );

  const { result, diagnostics } = runStyleCheck(directory);

  const unusedOxlint = diagnostics.filter((diagnostic) =>
    diagnostic.includes('Unused oxlint-disable directive'),
  );

  const unusedEslint = diagnostics.filter((diagnostic) =>
    diagnostic.includes('Unused eslint-disable directive'),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(unusedOxlint).toHaveLength(1);
  expect(unusedOxlint[0]).toContain(`${fixture}:1:1`);
  expect(unusedEslint).toHaveLength(1);
  expect(unusedEslint[0]).toContain(`${fixture}:2:1`);
}, 30_000);

it('fails a reasoned @ts-ignore and a reasonless @ts-expect-error', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-ts-');
  const fixture = join(directory, 'tsComments.ts');

  await writeFile(
    fixture,
    [
      '// @ts-ignore -- The fixture passes a string where a number is required.',
      "export const ignored: number = 'text';",
      '',
      '// @ts-expect-error',
      "export const expected: number = 'text';",
      '',
    ].join('\n'),
  );

  const { result, diagnostics } = runStyleCheck(directory);

  const comments = diagnostics.filter((diagnostic) =>
    diagnostic.includes('typescript(ban-ts-comment)'),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(comments).toHaveLength(2);

  const atLineOne = diagnosticsAt(comments, fixture, 1);
  const atLineFour = diagnosticsAt(comments, fixture, 4);

  expect(atLineOne).toHaveLength(1);
  expect(atLineOne[0]).toContain(`${fixture}:1:`);
  expect(atLineFour).toHaveLength(1);
  expect(atLineFour[0]).toContain(`${fixture}:4:`);

  for (const diagnostic of comments) {
    expect(diagnostic).toContain('help:');
  }
}, 30_000);

it('passes reasoned suppressions without markers', async ({ onTestFinished }) => {
  const directory = createFixtureRoot(onTestFinished, 'tau-style-reasoned-');
  const fixture = join(directory, 'reasoned.ts');

  await writeFile(
    fixture,
    [
      '// oxlint-disable-next-line eslint/no-console -- The fixture prints its own output.',
      "console.log('one');",
      '',
      '// eslint-disable-next-line eslint/no-console -- The fixture prints its own output.',
      "console.log('two');",
      '',
      '// @ts-expect-error -- The fixture passes a string where a number is required.',
      "export const value: number = 'text';",
      '',
    ].join('\n'),
  );

  const { result, diagnostics } = runStyleCheck(directory);

  const guardedMarkers = [
    'vitest(no-focused-tests)',
    'vitest(no-disabled-tests)',
    'seam(require-disable-reason)',
    'typescript(ban-ts-comment)',
    'Unused oxlint-disable directive',
    'Unused eslint-disable directive',
  ];

  const guarded = diagnostics.filter((diagnostic) =>
    guardedMarkers.some((marker) => diagnostic.includes(marker)),
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(guarded).toEqual([]);
}, 30_000);
