import { matchesGlob } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyPath, tddConfig } from './config.js';

describe('TDD config', () => {
  it('exports the production, test, and JSON verification contract', () => {
    expect(tddConfig.productionGlobs).toEqual(['src/**/*.{ts,tsx}']);
    expect(tddConfig.testGlobs).toEqual(['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}']);
    expect(tddConfig.verificationArgv).toEqual(['vitest', 'run', '--reporter=json', '--no-color']);
  });

  it('gives test globs precedence, then production globs, then other', () => {
    expect(matchesGlob('src/example.test.ts', tddConfig.productionGlobs[0])).toBe(true);
    expect(classifyPath('src/example.test.ts')).toBe('test');
    expect(classifyPath('src/component.spec.tsx')).toBe('test');
    expect(classifyPath('tests/example.test.ts')).toBe('test');
    expect(classifyPath('example.spec.ts')).toBe('test');
    expect(classifyPath('src/example.ts')).toBe('production');
    expect(classifyPath('src/component.tsx')).toBe('production');
    expect(classifyPath('scripts/check.js')).toBe('other');
    expect(classifyPath('README.md')).toBe('other');
    expect(classifyPath('docs/example.md')).toBe('other');
    expect(classifyPath('src/example.css')).toBe('other');
  });

  it('classifies backslash-separated paths like their forward-slash form', () => {
    expect(classifyPath('src\\example.test.ts')).toBe('test');
    expect(classifyPath('tests\\nested\\component.spec.tsx')).toBe('test');
    expect(classifyPath('src\\example.ts')).toBe('production');
    expect(classifyPath('src\\nested\\value.ts')).toBe('production');
  });
});
