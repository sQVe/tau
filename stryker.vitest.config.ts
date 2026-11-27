import base from './vite.config.ts';

const { projects: _projects, ...test } = base.test ?? {};

export default {
  ...base,
  test: {
    ...test,
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    // A test file reports the mutant coverage collected so far, so test files that share a module
    // registry make the report grow with the square of the file count. Keep each file isolated.
    isolate: true,
  },
};
