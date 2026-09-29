import { spawnSync } from 'node:child_process';

import piManifest from '../node_modules/@earendil-works/pi-coding-agent/package.json' with { type: 'json' };
import { piVersionDrift } from './piVersionDrift.ts';

const result = spawnSync('pi', ['--version'], { encoding: 'utf8' });

if (result.error) {
  process.stdout.write(
    `Skipped the Pi version check: pi is not runnable (${result.error.message}).\n`,
  );
} else {
  const drift = piVersionDrift(result.stdout, piManifest.version);

  if (drift !== undefined) {
    process.stderr.write(`${drift}\n`);
    process.exitCode = 1;
  }
}
