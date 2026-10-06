import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { installedPiPath } from '../../../scripts/piVersionDrift.js';
import { defaultTddConfig } from './config.js';
import { fingerprintInputs } from './inputFingerprint.js';

// The installed Pi is a Bun executable, and `BUN_BE_BUN` makes it run a script as Bun. CI has
// only the dependency's Node `pi`, so this check runs where Pi is installed.
const piEnvironment = {
  ...process.env,
  PATH: installedPiPath(process.env.PATH ?? '', delimiter),
  BUN_BE_BUN: '1',
};

const canRunInstalledPi =
  spawnSync('pi', ['--version'], { env: piEnvironment, timeout: 5000, stdio: 'ignore' }).status ===
  0;

const runUnderPi = (script: string, cwd: string) =>
  spawnSync('pi', [script, cwd], { env: piEnvironment, encoding: 'utf8', timeout: 30_000 });

it.runIf(canRunInstalledPi)(
  'fingerprints inputs under the Bun runtime of the installed Pi',
  async ({ onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-input-fingerprint-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));

    await mkdir(join(cwd, 'src/nested'), { recursive: true });
    await writeFile(join(cwd, 'src/value.ts'), 'value');
    await writeFile(join(cwd, 'value.test.ts'), 'test');

    const module = fileURLToPath(new URL('inputFingerprint.ts', import.meta.url));
    const configModule = fileURLToPath(new URL('config.ts', import.meta.url));
    const script = join(cwd, 'fingerprint.mts');

    await writeFile(
      script,
      [
        `import { fingerprintInputs } from ${JSON.stringify(module)};`,
        `import { defaultTddConfig } from ${JSON.stringify(configModule)};`,
        `const config = { ...defaultTddConfig, productionGlobs: ['src/**'] };`,
        `const fingerprint = await fingerprintInputs(process.argv[2], config, ['value.test.ts']);`,
        `console.log(JSON.stringify({ runtime: typeof Bun, fingerprint }));`,
      ].join('\n'),
    );

    const config = { ...defaultTddConfig, productionGlobs: ['src/**'] };
    const expected = await fingerprintInputs(cwd, config, ['value.test.ts']);
    const result = runUnderPi(script, cwd);

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ runtime: 'object', fingerprint: expected });
    expect(expected).not.toBeNull();
  },
);
