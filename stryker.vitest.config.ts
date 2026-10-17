import base from './vite.config.ts';

const { projects: _projects, ...test } = base.test ?? {};

export default {
  ...base,
  test: {
    ...test,
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/tau-lint-*/**'],
  },
};
