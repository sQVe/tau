import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Vitest from 'vitest/node';

import { chaiDisplayCut } from './testNames.ts';
import { normalizeVitestOptions } from './vitestOptions.ts';

const [binaryPath, fileCountArgument, ...argumentsList] = process.argv.slice(2);

if (binaryPath === undefined) {
  throw new Error('The focused runner requires the project Vitest binary path.');
}

const fileCount = Number(fileCountArgument);

if (!Number.isSafeInteger(fileCount) || fileCount < 1) {
  throw new Error('The focused runner requires a positive file count.');
}

if (argumentsList.length < fileCount) {
  throw new Error('The focused runner did not receive all requested files.');
}

const files = argumentsList.slice(0, fileCount).map((file) => resolve(process.cwd(), file));
const [displayCutArgument, ...runnerArguments] = argumentsList.slice(fileCount);
const displayCut = Number(displayCutArgument);

if (!Number.isSafeInteger(displayCut) || displayCut < 0) {
  throw new Error('The focused runner requires a non-negative display cut.');
}

const projectRequire = createRequire(binaryPath);
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Node's require is untyped; this loads the resolved package's public Vitest API.
const { startVitest, parseCLI }: typeof Vitest = projectRequire('vitest/node');
const { filter, options } = parseCLI(['vitest', ...runnerArguments]);
const reporterPath = fileURLToPath(new URL('./vitestSelectionReporter.ts', import.meta.url));

const { reporters: cliConfiguredReporters, ...normalizedOptions } = normalizeVitestOptions(
  filter,
  options,
);

if ('reporter' in normalizedOptions && Array.isArray(normalizedOptions.reporter)) {
  normalizedOptions.reporter.push(reporterPath);
}

// Vitest renders an `it.each` "$name" through chai's display cut and stores that rendered name, so
// an exact filter on the name written in the table would never match. Raise the cut just enough for
// the longest requested name, and leave it alone for a run that cannot need it.
const withoutDisplayCut = <Test extends { chaiConfig?: { truncateThreshold?: number } }>(
  test: Test,
  requiredCut: number,
): Test => {
  const configured = test.chaiConfig?.truncateThreshold ?? chaiDisplayCut;
  const truncateThreshold = configured === 0 ? 0 : Math.max(configured, requiredCut);

  return { ...test, chaiConfig: { ...test.chaiConfig, truncateThreshold } };
};

try {
  const context = await startVitest('test', [], normalizedOptions, {
    plugins: [
      {
        name: 'tau-exact-focused-files',
        config(config) {
          const configuredReporters = cliConfiguredReporters ??
            config.test?.reporters ?? ['default'];

          const reporters = Array.isArray(configuredReporters)
            ? [...configuredReporters]
            : [configuredReporters];

          reporters.push([reporterPath, { files }]);
          config.test = withoutDisplayCut(config.test ?? {}, displayCut);
          config.test.reporters = reporters;

          // An inline project resolves its own test config, so it needs the same cut removed.
          for (const project of config.test.projects ?? []) {
            if (typeof project === 'object' && 'test' in project) {
              project.test = withoutDisplayCut(project.test ?? {}, displayCut);
            }
          }
        },
      },
    ],
  });

  if (!context.shouldKeepServer()) {
    await context.exit();
  }
} catch (error) {
  // oxlint-disable-next-line no-console -- This child entry reports startup failures on stderr, like Vitest's CLI.
  console.error('\nStartup Error\n', error);
  process.exitCode ??= 1;
  process.exit();
}
