import base from './vite.config.ts';

const { projects: _projects, ...test } = base.test ?? {};

export default {
  ...base,
  test: {
    ...test,
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    // A test file without its own module registry reports the mutant coverage of every test file
    // before it. Keep each file isolated so each report holds only that file's coverage.
    isolate: true,
  },
};
