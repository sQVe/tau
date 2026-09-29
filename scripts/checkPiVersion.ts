import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

import piManifest from '../node_modules/@earendil-works/pi-coding-agent/package.json' with { type: 'json' };
import { installedPiPath, piVersionDrift } from './piVersionDrift.ts';

const result = spawnSync('pi', ['--version'], {
  encoding: 'utf8',
  // oxlint-disable-next-line node/no-process-env -- The installed pi is found on the caller's PATH.
  env: { ...process.env, PATH: installedPiPath(process.env.PATH ?? '', delimiter) },
});

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
