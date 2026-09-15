import { matchesGlob } from 'node:path';

export const tddConfig = {
  productionGlobs: ['src/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  testGlobs: ['**/*.test.{ts,tsx,js,jsx,mjs,cjs}', '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}'],
  // The default reporter keeps console and setup diagnostics; JSON alone omits them.
  verificationArgv: ['vitest', 'run', '--reporter=json', '--reporter=default', '--no-color'],
} as const;

// Vitest loads its own configuration before Vite's. Hash both because either can change which tests run.
const configurationExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];

export const configurationPaths = [
  'package.json',
  ...['vite', 'vitest'].flatMap((name) =>
    configurationExtensions.map((extension) => `${name}.config.${extension}`),
  ),
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
