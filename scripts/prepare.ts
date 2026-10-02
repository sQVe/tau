import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Pi installs Tau from Git without devDependencies but still runs `prepare`. Without Vite+ there
// are no Git hooks to configure.
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
