import { matchesGlob } from 'node:path';

export const tddConfig = {
  productionGlobs: ['{src,apps,packages,functions,infra}/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  testGlobs: ['**/*.test.{ts,tsx,js,jsx,mjs,cjs}', '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}'],
  testSupportGlobs: ['tests/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  excludedGlobs: [
    '**/{node_modules,.git,dist,build,coverage,.next,.nuxt,.output,.turbo,.cache,generated,__generated__}/**',
  ],
  // The default reporter keeps console and setup diagnostics; JSON alone omits them.
  verificationArgv: ['vitest', 'run', '--reporter=json', '--reporter=default', '--no-color'],
} as const;

// Vitest loads its own configuration before Vite's. Hash both because either can change which tests run.
export const configurationGlobs = [
  '**/package.json',
  '**/{vite,vitest}.config.{ts,mts,cts,js,mjs,cjs}',
  '**/vitest.workspace.{ts,mts,cts,js,mjs,cjs,json}',
  '**/tsconfig*.json',
  '**/{pnpm-lock.yaml,package-lock.json,npm-shrinkwrap.json,yarn.lock,bun.lock,bun.lockb,pnpm-workspace.yaml}',
];

export const classifyPath = (path: string): 'test' | 'production' | 'other' => {
  const normalizedPath = path.replaceAll('\\', '/');

  if (tddConfig.excludedGlobs.some((glob) => matchesGlob(normalizedPath, glob))) {
    return 'other';
  }

  const isTest = tddConfig.testGlobs.some((glob) => matchesGlob(normalizedPath, glob));

  if (isTest) {
    return 'test';
  }

  return tddConfig.productionGlobs.some((glob) => matchesGlob(normalizedPath, glob))
    ? 'production'
    : 'other';
};
