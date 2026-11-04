import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { ConfigWarnings } from '../../config/config.js';
import { classifyPath, defaultTddConfig, loadTddConfig } from './config.js';
import { unsupportedGlobReason } from './inputGlob.js';
import { runners } from './runner/runners.js';
import type { TestRunner } from './runner/types.js';
import { vitestRunner } from './runner/vitest.js';

const classify = (path: string, testFilesCanBeProduction = false) =>
  classifyPath(defaultTddConfig, path, testFilesCanBeProduction);

describe('TDD config', () => {
  it('gives a test role to test globs and a production role to production globs', () => {
    expect(classify('src/example.test.ts')).toEqual({ test: true, production: false });
    expect(classify('src/component.spec.tsx')).toEqual({ test: true, production: false });
    expect(classify('tests/example.test.ts')).toEqual({ test: true, production: false });
    expect(classify('tests/commitTool.ts')).toEqual({ test: false, production: false });
    expect(classify('tests/fixtures/helper.ts')).toEqual({ test: false, production: false });
    expect(classify('example.spec.ts')).toEqual({ test: true, production: false });
    expect(classify('src/example.ts')).toEqual({ test: false, production: true });
    expect(classify('src/component.tsx')).toEqual({ test: false, production: true });

    for (const path of ['src/x.js', 'src/x.jsx', 'src/x.mjs', 'src/x.cjs']) {
      expect(classify(path)).toEqual({ test: false, production: true });
    }

    expect(classify('src/x.test.js')).toEqual({ test: true, production: false });
    expect(classify('src/x.spec.mjs')).toEqual({ test: true, production: false });
    expect(classify('scripts/check.js')).toEqual({ test: false, production: false });
    expect(classify('README.md')).toEqual({ test: false, production: false });
    expect(classify('docs/example.md')).toEqual({ test: false, production: false });
    expect(classify('src/example.css')).toEqual({ test: false, production: false });
  });

  it('counts a file matching both glob lists as production when the runner allows overlap', () => {
    const config = {
      ...defaultTddConfig,
      testGlobs: ['**/*.test.ts'],
      productionGlobs: ['src/**/*.ts'],
    };

    expect(classifyPath(config, 'src/example.test.ts', true)).toEqual({
      test: true,
      production: true,
    });

    expect(classifyPath(config, 'src/example.test.ts', false)).toEqual({
      test: true,
      production: false,
    });
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
      expect(classify(path)).toEqual({ test: false, production: true });
    }

    expect(classify('apps/web/src/page.test.tsx')).toEqual({ test: true, production: false });
    expect(classify('packages/core/index.spec.ts')).toEqual({ test: true, production: false });
    expect(classify('scripts/release.ts')).toEqual({ test: false, production: false });
    expect(classify('docs/example.ts')).toEqual({ test: false, production: false });
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
        expect(classify(`apps/web/${directory}/${file}`)).toEqual({
          test: false,
          production: false,
        });

        expect(classify(`${directory}/src/${file}`)).toEqual({ test: false, production: false });

        expect(classify(`packages\\core\\${directory}\\${file}`)).toEqual({
          test: false,
          production: false,
        });
      }
    }
  });

  it('classifies backslash-separated paths like their forward-slash form', () => {
    expect(classify('src\\example.test.ts')).toEqual({ test: true, production: false });

    expect(classify('tests\\nested\\component.spec.tsx')).toEqual({
      test: true,
      production: false,
    });

    expect(classify('src\\example.ts')).toEqual({ test: false, production: true });
    expect(classify('src\\nested\\value.ts')).toEqual({ test: false, production: true });
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
      runners,
    );

    expect(classifyPath(config, 'internal/git/status.go', false)).toEqual({
      test: false,
      production: true,
    });

    expect(classifyPath(config, 'src/value.ts', false)).toEqual({ test: false, production: false });
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
      runners,
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
      runners,
    );

    expect(config.verificationArgv).toEqual(['vitest', 'run', '--silent']);
  });

  it('loads the Vitest defaults with the runner name when no file sets one', async ({
    onTestFinished,
  }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-default-');

    const { config, sources } = loadTddConfig(
      { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
      { notify: () => undefined },
      runners,
    );

    expect(config).toEqual({ ...defaultTddConfig, runner: 'vitest' });

    expect(sources).toEqual({
      runner: 'built-in default',
      productionGlobs: 'built-in default',
      testGlobs: 'built-in default',
      testSupportGlobs: 'built-in default',
      excludedGlobs: 'built-in default',
      verificationArgv: 'built-in default',
    });
  });

  it('loads the selected runner from a config file', async ({ onTestFinished }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-runner-');
    await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, '.pi', 'tau.json'), JSON.stringify({ tdd: { runner: 'vitest' } }));

    const { config, sources } = loadTddConfig(
      { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
      { notify: () => undefined },
      runners,
    );

    expect(config).toEqual(defaultTddConfig);
    expect(sources.runner).toBe(join(cwd, '.pi', 'tau.json'));
  });

  it('refuses a runner name that only exists on the object prototype', async ({
    onTestFinished,
  }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-runner-');
    await mkdir(join(cwd, '.pi'));

    await writeFile(
      join(cwd, '.pi', 'tau.json'),
      JSON.stringify({ tdd: { runner: 'constructor' } }),
    );

    const loading = () =>
      loadTddConfig(
        { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
        { notify: () => undefined },
        runners,
      );

    expect(loading).toThrow('runner "constructor" is unknown');
    expect(loading).toThrow('Known runners: nextest, vitest');
  });

  it('validates the merged command with the selected runner and names the file that set it', async ({
    onTestFinished,
  }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-config-runner-');
    await mkdir(join(cwd, '.pi'));
    await mkdir(join(cwd, 'agent'));

    await writeFile(
      join(cwd, 'agent', 'tau.json'),
      JSON.stringify({ tdd: { runner: 'fake', verificationArgv: ['bad-command'] } }),
    );

    await writeFile(
      join(cwd, '.pi', 'tau.json'),
      JSON.stringify({ tdd: { excludedGlobs: ['dist/**'] } }),
    );

    const fakeRunner: TestRunner = {
      ...vitestRunner,
      name: 'fake',
      defaults: { ...vitestRunner.defaults, runner: 'fake', verificationArgv: ['fake', 'run'] },
      verificationArgvError: (verificationArgv) =>
        verificationArgv[0] === 'fake' ? null : 'fake runner needs its own command.',
    };

    const loading = () =>
      loadTddConfig(
        { cwd, agentDirectory: join(cwd, 'agent'), projectTrusted: true },
        { notify: () => undefined },
        { fake: fakeRunner },
        'fake',
      );

    expect(loading).toThrow(join(cwd, 'agent', 'tau.json'));
    expect(loading).toThrow('fake runner needs its own command.');
  });

  it.for<[string, string, string]>([
    ['.pi/tau.json', '{', '.pi/tau.json'],
    ['.pi/tau.json', '[]', '.pi/tau.json'],
    ['.pi/tau.json', '{"tdd": {"productionGlobs": "src"}}', 'productionGlobs'],
    ['.pi/tau.json', '{"tdd": {"testGlobs": ["", "**/*.test.ts"]}}', 'testGlobs'],
    ['.pi/tau.json', '{"tdd": {"runner": "jest"}}', 'vitest'],
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
        runners,
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
        runners,
      );

    expect(loading).toThrow(glob);
  });

  it('classifies a leading ./ test glob and a dot file as the fingerprint walk lists them', () => {
    const config = {
      ...defaultTddConfig,
      testGlobs: ['./src/**/*.test.ts'],
      productionGlobs: ['./lib/**/*.ts'],
    };

    expect(classifyPath(config, 'src/a.test.ts', false)).toEqual({ test: true, production: false });
    expect(classifyPath(config, 'lib/a.ts', false)).toEqual({ test: false, production: true });

    expect(classifyPath(defaultTddConfig, 'src/.hidden.test.ts', false)).toEqual({
      test: true,
      production: false,
    });

    expect(classifyPath(defaultTddConfig, '.hidden/a.test.ts', false)).toEqual({
      test: true,
      production: false,
    });

    expect(classifyPath(defaultTddConfig, 'src/.hidden.ts', false)).toEqual({
      test: false,
      production: true,
    });
  });

  it('supports every built-in glob', () => {
    const builtIn = [
      ...defaultTddConfig.productionGlobs,
      ...defaultTddConfig.testGlobs,
      ...defaultTddConfig.testSupportGlobs,
      ...defaultTddConfig.excludedGlobs,
      ...vitestRunner.configurationGlobs,
    ];

    expect(builtIn.map(unsupportedGlobReason)).toEqual(builtIn.map(() => null));
  });
});
