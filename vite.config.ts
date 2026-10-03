import { format, lint, vitest } from '@sqve/seam';
import { defineConfig } from 'vite-plus';

const testHelperImports = {
  group: ['**/tests/**'],
  message: 'Production code must not import test helpers.',
};

export default defineConfig({
  test: {
    // Integration tests launch Git, Node, and nested Vitest processes. Limit competing workers.
    maxWorkers: 6,
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
      'tau/extension-boundary': 'error',
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
        // Every module under src/ is shared; the next override restores extensions and the
        // package entry.
        files: ['src/*.ts', 'src/*/**/*.ts'],
        rules: {
          'eslint/no-restricted-imports': [
            'error',
            {
              patterns: [
                testHelperImports,
                {
                  group: ['**/extensions/**'],
                  message: 'Shared modules must not depend on extensions.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ['src/tau.ts', 'src/extensions/**/*.ts'],
        rules: {
          'eslint/no-restricted-imports': ['error', { patterns: [testHelperImports] }],
        },
      },
      {
        files: ['src/extensions/subagents/**/*.ts'],
        rules: {
          'eslint/no-restricted-imports': [
            'error',
            {
              patterns: [
                testHelperImports,
                {
                  group: [
                    '**/controller/*',
                    '!**/controller/controller.js',
                    '!**/controller/record.js',
                    '!**/controller/budget.js',
                  ],
                  message:
                    'This controller file is private. Import controller.ts, record.ts, or budget.ts, or make the file public in vite.config.ts.',
                },
              ],
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
            { assertFunctionNames: ['expect', 'runPiWorkerScenario'] },
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
