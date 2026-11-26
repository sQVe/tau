import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// pnpm `install --prod` skips root `prepare`, so the build runs in `postinstall`. This script only
// sets up hooks when Vite+ is installed.
const vitePlus = join('node_modules', '.bin', 'vp');

if (existsSync(vitePlus)) {
  const result = spawnSync(vitePlus, ['config'], { stdio: 'inherit' });

  if (result.error) {
    process.stderr.write(`Could not run vp config: ${result.error.message}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
