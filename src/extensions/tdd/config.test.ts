import { matchesGlob } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyPath, tddConfig } from './config.js';

describe('TDD config', () => {
  it('defines production globs, test globs, and JSON verification arguments', () => {
    expect(tddConfig.productionGlobs).toEqual([
      '{src,apps,packages,functions,infra}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
    ]);
    expect(tddConfig.testGlobs).toEqual([
      '**/*.test.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}',
    ]);
    expect(tddConfig.verificationArgv).toEqual([
      'vitest',
      'run',
      '--reporter=json',
      '--reporter=default',
      '--no-color',
    ]);
  });

  it('gives test globs precedence, then production globs, then other', () => {
    expect(matchesGlob('src/example.test.ts', tddConfig.productionGlobs[0])).toBe(true);
    expect(classifyPath('src/example.test.ts')).toBe('test');
    expect(classifyPath('src/component.spec.tsx')).toBe('test');
    expect(classifyPath('tests/example.test.ts')).toBe('test');
    expect(classifyPath('tests/commitTool.ts')).toBe('other');
    expect(classifyPath('tests/fixtures/helper.ts')).toBe('other');
    expect(classifyPath('example.spec.ts')).toBe('test');
    expect(classifyPath('src/example.ts')).toBe('production');
    expect(classifyPath('src/component.tsx')).toBe('production');

    for (const path of ['src/x.js', 'src/x.jsx', 'src/x.mjs', 'src/x.cjs']) {
      expect(classifyPath(path)).toBe('production');
    }

    expect(classifyPath('src/x.test.js')).toBe('test');
    expect(classifyPath('src/x.spec.mjs')).toBe('test');
    expect(classifyPath('scripts/check.js')).toBe('other');
    expect(classifyPath('README.md')).toBe('other');
    expect(classifyPath('docs/example.md')).toBe('other');
    expect(classifyPath('src/example.css')).toBe('other');
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
      expect(classifyPath(path)).toBe('production');
    }

    expect(classifyPath('apps/web/src/page.test.tsx')).toBe('test');
    expect(classifyPath('packages/core/index.spec.ts')).toBe('test');
    expect(classifyPath('scripts/release.ts')).toBe('other');
    expect(classifyPath('docs/example.ts')).toBe('other');
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
        expect(classifyPath(`apps/web/${directory}/${file}`)).toBe('other');
        expect(classifyPath(`${directory}/src/${file}`)).toBe('other');
        expect(classifyPath(`packages\\core\\${directory}\\${file}`)).toBe('other');
      }
    }
  });

  it('classifies backslash-separated paths like their forward-slash form', () => {
    expect(classifyPath('src\\example.test.ts')).toBe('test');
    expect(classifyPath('tests\\nested\\component.spec.tsx')).toBe('test');
    expect(classifyPath('src\\example.ts')).toBe('production');
    expect(classifyPath('src\\nested\\value.ts')).toBe('production');
  });
});
