import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HcCommandFiles {
  bin: string;
  log: string;
}

export const emptySessionRefusal = 'refused hc with an empty HC_SESSION';

// The package starts hc as a child process, so the fake is a script on PATH rather than an
// in-process fake. It refuses a command with no HC_SESSION, so no test can reach the user's core.
export const installHcCommand = (directory: string): HcCommandFiles => {
  const bin = join(directory, 'bin');
  const log = join(directory, 'hc.log');

  mkdirSync(bin, { recursive: true });

  writeFileSync(
    join(bin, 'hc'),
    `#!/bin/sh
if [ -z "\${HC_SESSION:-}" ]; then
  printf '%s\\n' '${emptySessionRefusal}' >> "$HC_FAKE_LOG"
  exit 64
fi
printf '%s\\n' "$*" >> "$HC_FAKE_LOG"
printf '{"terminals":[]}\\n'
`,
  );

  chmodSync(join(bin, 'hc'), 0o755);

  return { bin, log };
};
