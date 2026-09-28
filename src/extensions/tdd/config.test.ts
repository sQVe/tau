import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('reads the grove layout from .pi/tau.json and ignores other top-level keys', async ({
    onTestFinished,
  }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-config-load-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, '.pi'));

    await writeFile(
      join(cwd, '.pi', 'tau.json'),
      JSON.stringify({ formatters: {}, tdd: { productionGlobs: ['{internal,cmd}/**/*.go'] } }),
    );

    const { config } = await loadTddConfig({
      cwd,
      agentDirectory: join(cwd, 'agent'),
      projectTrusted: true,
    });

    expect(classifyPath(config, 'internal/git/status.go')).toBe('production');
    expect(classifyPath(config, 'src/value.ts')).toBe('other');
  });

  it.for<[string, string, string]>([
    ['.pi/tau.json', '{', 'JSON'],
    ['.pi/tau.json', '[]', 'object'],
    ['.pi/tau.json', '{"tdd": {"productionGlob": []}}', 'productionGlob'],
    ['.pi/tau.json', '{"tdd": {"testGlobs": ["", "**/*.test.ts"]}}', 'testGlobs'],
    ['.pi/tau.json', '{"tdd": {"verificationArgv": ["jest"]}}', 'verificationArgv'],
    ['.pi/tau.json', '{"tdd": {"verificationArgv": []}}', 'verificationArgv'],
    ['agent/tau.json', '{"tdd": {"excludedGlobs": "dist"}}', 'excludedGlobs'],
  ])('names %s and the problem for %s', async ([file, content, problem], { onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-config-invalid-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, '.pi'));
    await mkdir(join(cwd, 'agent'));
    await writeFile(join(cwd, file), content);

    const loading = loadTddConfig({
      cwd,
      agentDirectory: join(cwd, 'agent'),
      projectTrusted: true,
    });

    await expect(loading).rejects.toThrow(join(cwd, file));
    await expect(loading).rejects.toThrow(problem);
  });
});
