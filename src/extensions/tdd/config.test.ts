import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyPath, defaultTddConfig, loadTddConfig } from './config.js';

const classify = (path: string) => classifyPath(defaultTddConfig, path);

describe('TDD config', () => {
  it('gives test globs precedence, then production globs, then other', () => {
    expect(classify('src/example.test.ts')).toBe('test');
    expect(classify('src/component.spec.tsx')).toBe('test');
    expect(classify('tests/example.test.ts')).toBe('test');
    expect(classify('tests/commitTool.ts')).toBe('other');
    expect(classify('tests/fixtures/helper.ts')).toBe('other');
    expect(classify('example.spec.ts')).toBe('test');
    expect(classify('src/example.ts')).toBe('production');
    expect(classify('src/component.tsx')).toBe('production');

    for (const path of ['src/x.js', 'src/x.jsx', 'src/x.mjs', 'src/x.cjs']) {
      expect(classify(path)).toBe('production');
    }

    expect(classify('src/x.test.js')).toBe('test');
    expect(classify('src/x.spec.mjs')).toBe('test');
    expect(classify('scripts/check.js')).toBe('other');
    expect(classify('README.md')).toBe('other');
    expect(classify('docs/example.md')).toBe('other');
    expect(classify('src/example.css')).toBe('other');
  });

  it('classifies the supported production layouts without treating every script as production', () => {
    for (const path of [
      'apps/web/src/page.tsx',
      'apps/web/routes/api.js',
      'packages/core/index.ts',
      'functions/notify/handler.mjs',
      'infra/stacks/main.ts',
      'packages\\core\\index.ts',
    ]) {
      expect(classify(path)).toBe('production');
    }

    expect(classify('apps/web/src/page.test.tsx')).toBe('test');
    expect(classify('packages/core/index.spec.ts')).toBe('test');
    expect(classify('scripts/release.ts')).toBe('other');
    expect(classify('docs/example.ts')).toBe('other');
  });

  it('excludes dependencies and generated directories before classifying source or tests', () => {
    for (const directory of [
      'node_modules',
      '.git',
      'dist',
      'build',
      'coverage',
      '.next',
      '.nuxt',
      '.output',
      '.turbo',
      '.cache',
      'generated',
      '__generated__',
    ]) {
      for (const file of ['value.ts', 'value.test.ts']) {
        expect(classify(`apps/web/${directory}/${file}`)).toBe('other');
        expect(classify(`${directory}/src/${file}`)).toBe('other');
        expect(classify(`packages\\core\\${directory}\\${file}`)).toBe('other');
      }
    }
  });

  it('classifies backslash-separated paths like their forward-slash form', () => {
    expect(classify('src\\example.test.ts')).toBe('test');
    expect(classify('tests\\nested\\component.spec.tsx')).toBe('test');
    expect(classify('src\\example.ts')).toBe('production');
    expect(classify('src\\nested\\value.ts')).toBe('production');
  });

  it('replaces only the fields tau.json sets and keeps defaults without a file', async ({
    onTestFinished,
  }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-config-load-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));

    expect(await loadTddConfig(cwd)).toEqual({ source: undefined, config: defaultTddConfig });

    await writeFile(
      join(cwd, 'tau.json'),
      JSON.stringify({ tdd: { productionGlobs: ['{internal,cmd}/**/*.go'], testGlobs: [] } }),
    );

    const loaded = await loadTddConfig(cwd);

    expect(loaded).toEqual({
      source: join(cwd, 'tau.json'),
      config: { ...defaultTddConfig, productionGlobs: ['{internal,cmd}/**/*.go'], testGlobs: [] },
    });

    expect(classifyPath(loaded.config, 'internal/git/status.go')).toBe('production');
    expect(classifyPath(loaded.config, 'src/value.ts')).toBe('other');
  });

  it.for<[string, string]>([
    ['{', 'JSON'],
    ['[]', 'object'],
    ['{"tdd": {"productionGlob": []}}', 'productionGlob'],
    ['{"formatters": {}}', 'formatters'],
    ['{"tdd": {"testGlobs": ["", "**/*.test.ts"]}}', 'testGlobs'],
    ['{"tdd": {"verificationArgv": ["jest"]}}', 'verificationArgv'],
    ['{"tdd": {"verificationArgv": []}}', 'verificationArgv'],
  ])('names tau.json and the problem for %s', async ([content, problem], { onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-config-invalid-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, 'tau.json'), content);

    await expect(loadTddConfig(cwd)).rejects.toThrow(join(cwd, 'tau.json'));
    await expect(loadTddConfig(cwd)).rejects.toThrow(problem);
  });
});
