import { matchesGlob } from 'node:path';

export const tddConfig = {
  productionGlobs: ['src/**/*.{ts,tsx}'],
  testGlobs: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
  verificationArgv: ['vitest', 'run', '--reporter=json', '--no-color'],
} as const;

export const classifyPath = (path: string): 'test' | 'production' =>
  tddConfig.testGlobs.some((glob) => matchesGlob(path, glob)) ? 'test' : 'production';
