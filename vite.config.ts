import { join } from 'node:path';

import { format, lint, vitest } from '@sqve/seam';
import { defineConfig } from 'vite-plus';

interface TestProject {
  name: string;
  include: string[];
  exclude: string[];
  globalSetup?: string[];
}

const testHelperImports = {
  group: ['**/tests/**'],
  message: 'Production code must not import test helpers.',
};

// Each test file belongs to exactly one project; tests/structure.test.ts enforces it.
const subagentIntegrationTests = [
  'tests/subagent*.integration.test.ts',
  'tests/tauCapacity.integration.test.ts',
];

const dedicatedExtensions = ['subagents', 'pr', 'prFeedback', 'tdd', 'slice', 'commit'];

const testProjects: TestProject[] = [
  { name: 'core', include: ['src/**/*.test.ts'], exclude: ['src/extensions/**'] },
  { name: 'subagents', include: ['src/extensions/subagents/**/*.test.ts'], exclude: [] },
  {
    name: 'pr',
    include: ['src/extensions/pr/**/*.test.ts', 'src/extensions/prFeedback/**/*.test.ts'],
    exclude: [],
  },
  { name: 'tdd', include: ['src/extensions/tdd/**/*.test.ts'], exclude: [] },
  { name: 'slice', include: ['src/extensions/slice/**/*.test.ts'], exclude: [] },
  { name: 'commit', include: ['src/extensions/commit/**/*.test.ts'], exclude: [] },
  {
    name: 'extensions',
    include: ['src/extensions/**/*.test.ts'],
    exclude: dedicatedExtensions.map((directory) => `src/extensions/${directory}/**`),
  },
  {
    name: 'repository',
    include: ['*.test.ts', 'tests/*.test.ts', 'scripts/**/*.test.ts', 'lint/**/*.test.ts'],
    exclude: ['tests/*.integration.test.ts'],
  },
  { name: 'integration-subagents', include: subagentIntegrationTests, exclude: [] },
  {
    name: 'integration',
    include: ['tests/*.integration.test.ts'],
    exclude: subagentIntegrationTests,
    globalSetup: [join(import.meta.dirname, 'tests', 'tauExtensionCacheHarness.ts')],
  },
];

// Two projects run at once, so the machine runs at most six Vitest workers, as in a full run.
const workersPerProject = 3;

// Variables that tests, fixtures, the watchdog, or the code under test read to decide a result.
// Tasks run in a clean environment that keeps only these and the Vite+ defaults. Only a change to
// these misses the cache. PATH is fingerprinted as the commands it resolves to, see taskEnvironment.
// HOME and NODE_OPTIONS are listed because file tracking cannot see a different home directory
// that has no earlier reads.
// Leave out herdr, Pi, Tau worker, and Git variables. Tests set those themselves, and they
// differ per pane or Git hook, so passing them would leak the shell and miss the cache.
export const testEnvironment = [
  'CI',
  'TAU_COLLECTION_TIMEOUT_MS',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'PATH',
  'HOME',
  'NODE_OPTIONS',
];

// Variables that test code reads but sets itself, so they stay out of the fingerprint. Tests stub
// them before reading, or this file sets or deletes them before the workers start.
export const testManagedEnvironment = ['PI_CODING_AGENT_DIR', 'TAU_WORKER_RECORD'];

// When pnpm check sets TAU_PATH_COMMANDS, the digest of the commands PATH resolves to stands in for
// PATH, so a reordered PATH keeps the cache. Vite+ still passes PATH to the tests.
// oxlint-disable-next-line node/no-process-env -- The fingerprint depends on the caller's environment.
const pathVariable = process.env.TAU_PATH_COMMANDS === undefined ? 'PATH' : 'TAU_PATH_COMMANDS';

const taskEnvironment = testEnvironment.map((name) => (name === 'PATH' ? pathVariable : name));

const projectTasks = Object.fromEntries(
  testProjects.map(({ name }) => [
    `vitest:${name}`,
    {
      command: `vp test run --project ${name} --maxWorkers ${workersPerProject}`,
      // Nothing needs restoring, and Vitest rewrites its own result cache on every run.
      output: [],
      env: taskEnvironment,
      // Tests ignore .tau/, but full_check writes a new log there on every run.
      input: [{ auto: true }, '!node_modules/.vite/**', '!.tau/**'],
    },
  ]),
);

export default defineConfig({
  run: {
    tasks: {
      ...projectTasks,
      'vitest:all': {
        command: 'true',
        dependsOn: testProjects.map(({ name }) => `vitest:${name}`),
      },
    },
  },
  test: {
    // Integration tests launch Git, Node, and nested Vitest processes. Limit competing workers.
    maxWorkers: 6,
    isolate: false,
    setupFiles: [
      join(import.meta.dirname, 'tests', 'hangWatchdog.ts'),
      join(import.meta.dirname, 'tests', 'testFileIsolationHarness.ts'),
    ],
    // Git in tests, and in the code under test, must ignore the developer's configuration.
    env: {
      // Tests must choose the worker environment themselves.
      TAU_WORKER_RECORD: '',
      HERDR_PANE_ID: '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Tau Test',
      GIT_AUTHOR_EMAIL: 'tau@example.com',
      GIT_AUTHOR_DATE: '2005-04-07T22:13:13Z',
      GIT_COMMITTER_NAME: 'Tau Test',
      GIT_COMMITTER_EMAIL: 'tau@example.com',
      GIT_COMMITTER_DATE: '2005-04-07T22:13:13Z',
      TZ: 'UTC',
    },
    // tests/lint.test.ts writes probe folders under src/ while other projects collect their tests.
    projects: testProjects.map(({ name, include, exclude, globalSetup }) => ({
      extends: true,
      test: {
        name,
        include,
        exclude: [...exclude, '**/tau-lint-*/**'],
        ...(globalSetup === undefined ? {} : { globalSetup }),
      },
    })),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/fixtures/**', 'src/tau.ts'],
    },
  },
  lint: {
    extends: [lint, vitest],
    jsPlugins: ['./lint/plugin.ts'],
    rules: {
      'tau/module-boundaries': 'error',
      'tau/no-enoent-literal': 'error',
    },
    overrides: [
      {
        files: ['src/**/*.ts'],
        rules: {
          'eslint/no-restricted-imports': [
            'error',
            {
              patterns: [testHelperImports],
            },
          ],
        },
      },
      {
        files: ['**/*.test.{ts,tsx}', '**/fixtures/**', 'tests/*.ts'],
        rules: {
          'eslint/no-restricted-imports': 'off',
          // Shared scenario runners assert inside the helper.
          'vitest/expect-expect': [
            'error',
            { assertFunctionNames: ['expect', 'runPiWorkerScenario', 'hangs', 'passes'] },
          ],
        },
      },
    ],
  },
  fmt: {
    ...format,
    // Local `.pi` agent state, including preserved review reports, is not source and must not be reformatted.
    ignorePatterns: ['pnpm-lock.yaml', '.pi/**'],
    overrides: [
      ...(format.overrides ?? []),
      // Snippet bodies are sent to the model as written, so wrapping them would
      // put hard line breaks in the middle of the instruction.
      {
        files: ['src/extensions/snippets/snippets/*.md'],
        options: { proseWrap: 'preserve' },
      },
    ],
  },
  staged: {
    '*.{ts,tsx,js,jsx,mjs,cjs}': ['seam', 'vp fmt --check --no-error-on-unmatched-pattern'],
    '!(pnpm-lock).{json,md,yaml,yml,css}': 'vp fmt --check --no-error-on-unmatched-pattern',
  },
});
