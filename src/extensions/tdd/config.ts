import { matchesGlob } from 'node:path';

export const tddConfig = {
  productionGlobs: ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  testGlobs: ['**/*.test.{ts,tsx,js,jsx,mjs,cjs}', '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}'],
  verificationArgv: ['vitest', 'run', '--reporter=json', '--no-color'],
} as const;

export const classifyPath = (path: string): 'test' | 'production' | 'other' => {
  const normalized = path.replaceAll('\\', '/');
  if (tddConfig.testGlobs.some((glob) => matchesGlob(normalized, glob))) return 'test';
  return tddConfig.productionGlobs.some((glob) => matchesGlob(normalized, glob))
    ? 'production'
    : 'other';
};
