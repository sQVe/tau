import { matchesGlob } from 'node:path';

export const tddConfig = {
  productionGlobs: ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  testGlobs: ['**/*.test.{ts,tsx,js,jsx,mjs,cjs}', '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}'],
  verificationArgv: ['vitest', 'run', '--reporter=json', '--no-color'],
} as const;

// Vitest loads its own configuration before Vite's. Hash and protect both configurations
// because either can change which tests run.
export const protectedPaths = [
  'package.json',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
];

export const classifyPath = (path: string): 'test' | 'production' | 'other' => {
  const normalizedPath = path.replaceAll('\\', '/');
  const isTest = tddConfig.testGlobs.some((glob) => matchesGlob(normalizedPath, glob));

  if (isTest) {
    return 'test';
  }

  return tddConfig.productionGlobs.some((glob) => matchesGlob(normalizedPath, glob))
    ? 'production'
    : 'other';
};
