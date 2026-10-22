import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { ConfigWarnings } from '../../config/config.js';
import { classifyPath, configurationGlobs, defaultTddConfig, loadTddConfig } from './config.js';
import { unsupportedGlobReason } from './inputGlob.js';

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
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-load-');
    await mkdir(join(cwd, '.pi'));

    await writeFile(
      join(cwd, '.pi', 'tau.json'),
      JSON.stringify({
        formatters: {},
        profiles: { scout: 'broken' },
        tdd: { productionGlobs: ['{internal,cmd}/**/*.go'] },
      }),
    );

    const { config } = loadTddConfig(
      { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
      { notify: () => undefined },
    );

    expect(classifyPath(config, 'internal/git/status.go')).toBe('production');
    expect(classifyPath(config, 'src/value.ts')).toBe('other');
  });

  it('reads known fields past unknown tdd keys and warns about each', async ({
    onTestFinished,
  }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-unknown-');
    await mkdir(join(cwd, '.pi'));
    const notify = vi.fn<ConfigWarnings['notify']>();

    await writeFile(
      join(cwd, '.pi', 'tau.json'),
      JSON.stringify({ tdd: { productionGlobs: ['lib/**'], futureKey: true } }),
    );

    const { config } = loadTddConfig(
      { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
      { notify },
    );

    expect(config.productionGlobs).toEqual(['lib/**']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('tdd.futureKey'), 'warning');
  });

  it('loads a configured verification command that starts with vitest', async ({
    onTestFinished,
  }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-argv-');
    await mkdir(join(cwd, '.pi'));

    await writeFile(
      join(cwd, '.pi', 'tau.json'),
      JSON.stringify({ tdd: { verificationArgv: ['vitest', 'run', '--silent'] } }),
    );

    const { config } = loadTddConfig(
      { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
      { notify: () => undefined },
    );

    expect(config.verificationArgv).toEqual(['vitest', 'run', '--silent']);
  });

  it.for<[string, string, string]>([
    ['.pi/tau.json', '{', '.pi/tau.json'],
    ['.pi/tau.json', '[]', '.pi/tau.json'],
    ['.pi/tau.json', '{"tdd": {"productionGlobs": "src"}}', 'productionGlobs'],
    ['.pi/tau.json', '{"tdd": {"testGlobs": ["", "**/*.test.ts"]}}', 'testGlobs'],
    ['.pi/tau.json', '{"tdd": {"verificationArgv": ["jest"]}}', 'verificationArgv'],
    ['.pi/tau.json', '{"tdd": {"verificationArgv": []}}', 'verificationArgv'],
    ['.pi/tau.json', '{"tdd": {"verificationArgv": ["vitest", ""]}}', 'verificationArgv'],
    ['agent/tau.json', '{"tdd": {"excludedGlobs": "dist"}}', 'excludedGlobs'],
  ])('names %s and the problem for %s', async ([file, content, problem], { onTestFinished }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-invalid-');
    await mkdir(join(cwd, '.pi'));
    await mkdir(join(cwd, 'agent'));
    await writeFile(join(cwd, file), content);

    const loading = () =>
      loadTddConfig(
        { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
        { notify: () => undefined },
      );

    expect(loading).toThrow(join(cwd, file));
    expect(loading).toThrow(problem);
  });

  it.for<[string, string]>([
    ['testGlobs', 'src/\\\\*.ts'],
    ['productionGlobs', 'f{a..c}.ts'],
    ['productionGlobs', 'f{-1..1}.ts'],
    ['testSupportGlobs', 'f{01..03}.ts'],
    ['excludedGlobs', 'f{}.ts'],
    ['excludedGlobs', 'f{1..3.ts'],
    ['productionGlobs', 'f1}.ts'],
    ['productionGlobs', 'f{1..2000000000}.ts'],
    ['productionGlobs', 'f{1..1000}{1..2}.ts'],
    ['productionGlobs', 'f{x}.ts'],
    ['productionGlobs', 'src/[a.ts'],
    ['productionGlobs', 'src/[ab][.ts'],
    ['productionGlobs', 'src/[{}].ts'],
    ['excludedGlobs', 'src/a].ts'],
    ['productionGlobs', 'src/+(a|b).ts'],
    ['productionGlobs', '{src,}/**'],
  ])('rejects %s entry %s and names the glob', async ([list, glob], { onTestFinished }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-glob-');
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi/tau.json'), JSON.stringify({ tdd: { [list]: [glob] } }));

    const loading = () =>
      loadTddConfig(
        { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
        { notify: () => undefined },
      );

    expect(loading).toThrow(glob);
  });

  it('classifies a leading ./ test glob and a dot file as the fingerprint walk lists them', () => {
    const config = {
      ...defaultTddConfig,
      testGlobs: ['./src/**/*.test.ts'],
      productionGlobs: ['./lib/**/*.ts'],
    };

    expect(classifyPath(config, 'src/a.test.ts')).toBe('test');
    expect(classifyPath(config, 'lib/a.ts')).toBe('production');
    expect(classifyPath(defaultTddConfig, 'src/.hidden.test.ts')).toBe('test');
    expect(classifyPath(defaultTddConfig, '.hidden/a.test.ts')).toBe('test');
    expect(classifyPath(defaultTddConfig, 'src/.hidden.ts')).toBe('production');
  });

  it('supports every built-in glob', () => {
    const builtIn = [
      ...defaultTddConfig.productionGlobs,
      ...defaultTddConfig.testGlobs,
      ...defaultTddConfig.testSupportGlobs,
      ...defaultTddConfig.excludedGlobs,
      ...configurationGlobs,
    ];

    expect(builtIn.map(unsupportedGlobReason)).toEqual(builtIn.map(() => null));
  });
});
