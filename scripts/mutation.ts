import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { formatMutationReport } from './mutationReport.ts';
import type { MutationReport } from './mutationReport.ts';
import { changedLinesDiffArguments, mutationScope } from './mutationScope.ts';
import type { MutationScope } from './mutationScope.ts';

const usage = `Usage: node scripts/mutation.ts <base> [<head>]

Runs StrykerJS on the production lines changed between base and head (default HEAD), then lists
the mutants that survived. Run it by hand; it is not part of pnpm check.`;

const print = (text: string) => process.stdout.write(`${text}\n`);

const printError = (text: string) => process.stderr.write(`${text}\n`);

const checkout = resolve(dirname(import.meta.filename), '..');

const reportPath = 'reports/mutation/mutation.json';

const maxGitOutput = Number.POSITIVE_INFINITY;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: maxGitOutput });

// The tree's own vite.config.ts decides the test options. Older commits have no projects.
const vitestConfig = (scope: MutationScope) => `import base from './vite.config.ts';

const { projects: _projects, ...test } = base.test ?? {};

export default {
  ...base,
  test: {
    ...test,
    include: ${JSON.stringify(scope.include)},
    exclude: ${JSON.stringify(scope.exclude)},
  },
};
`;

const strykerConfig = (scope: MutationScope) => ({
  testRunner: 'vitest',
  vitest: { configFile: 'stryker.vitest.config.ts', related: false },
  coverageAnalysis: 'perTest',
  mutate: scope.mutate,
  // TypeScript 7 has no JS API, so Stryker's tsconfig rewrite crashes. A missing file skips it.
  tsconfigFile: 'stryker-no-tsconfig.json',
  checkers: [],
  concurrency: 6,
  timeoutMS: 20_000,
  reporters: ['json', 'progress'],
  jsonReporter: { fileName: reportPath },
  fileLogLevel: 'info',
  ignorePatterns: ['.tau', 'docs', 'CHANGELOG.md'],
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
});

const exportTree = (head: string, directory: string) => {
  const archive = join(directory, 'head.tar');

  git('archive', '--format=tar', '-o', archive, head);
  execFileSync('tar', ['-xf', archive, '-C', directory]);
  rmSync(archive);
  symlinkSync(join(checkout, 'node_modules'), join(directory, 'node_modules'));
};

const writeConfigs = (directory: string, scope: MutationScope) => {
  writeFileSync(join(directory, 'stryker.vitest.config.ts'), vitestConfig(scope));

  writeFileSync(
    join(directory, 'stryker.config.json'),
    JSON.stringify(strykerConfig(scope), undefined, 2),
  );
};

const printReport = (directory: string) => {
  const text = readFileSync(join(directory, reportPath), 'utf8');
  // SAFETY: Stryker's JSON reporter writes this shape; the formatter reads only these fields.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the report is Stryker output.
  const report = JSON.parse(text) as MutationReport;

  const sources = Object.fromEntries(
    Object.keys(report.files).map((path) => [path, readFileSync(join(directory, path), 'utf8')]),
  );

  print(formatMutationReport(report, sources));
};

const run = () => {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [base, head = 'HEAD'] = positionals;

  if (base === undefined || positionals.length > 2) {
    printError(usage);
    process.exitCode = 2;

    return;
  }

  const diff = git(...changedLinesDiffArguments(base, head));
  const scope = mutationScope(diff);

  if (scope === undefined) {
    print(`Nothing to mutate: no production lines changed between ${base} and ${head}.`);

    return;
  }

  const directory = mkdtempSync(join(tmpdir(), 'tau-mutation-'));

  exportTree(head, directory);
  writeConfigs(directory, scope);
  print(`Mutating ${scope.mutate.length} range(s) of ${head} in ${directory}`);

  const stryker = spawnSync(join(checkout, 'node_modules/.bin/stryker'), ['run'], {
    cwd: directory,
    stdio: 'inherit',
  });

  if (stryker.status !== 0) {
    printError(
      `Stryker failed. Kept ${directory}; see ${join(directory, 'logs/stryker.log')} and ${join(directory, 'stryker.log')}.`,
    );

    process.exitCode = 1;

    return;
  }

  printReport(directory);
  rmSync(directory, { recursive: true, force: true });
};

run();
