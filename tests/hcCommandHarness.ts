import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HcCommandFiles {
  bin: string;
  log: string;
  replies: string;
  reply: (command: string, stdout: string) => void;
  replyGet: (address: string, stdout: string) => void;
}

export const emptySessionRefusal = 'refused hc with an empty HC_SESSION';

// The package starts hc as a child process, so the fake is a script on PATH rather than an
// in-process fake. It refuses a command with no HC_SESSION, so no test can reach the user's core.
// A reply file named after the command, or after `get` and its address, overrides the empty list.
export const installHcCommand = (directory: string): HcCommandFiles => {
  const bin = join(directory, 'bin');
  const log = join(directory, 'hc.log');
  const replies = join(directory, 'hc-replies');

  mkdirSync(bin, { recursive: true });
  mkdirSync(replies, { recursive: true });

  writeFileSync(
    join(bin, 'hc'),
    `#!/bin/sh
if [ -z "\${HC_SESSION:-}" ]; then
  printf '%s\\n' '${emptySessionRefusal}' >> "$HC_FAKE_LOG"
  exit 64
fi
printf '%s\\n' "$*" >> "$HC_FAKE_LOG"
last=''
for argument in "$@"; do
  last="$argument"
done
reply="\${HC_FAKE_REPLIES}/$1-$last"
if [ ! -f "$reply" ]; then
  reply="\${HC_FAKE_REPLIES}/$1"
fi
if [ -f "$reply" ]; then
  cat "$reply"
else
  printf '{"terminals":[]}\\n'
fi
`,
  );

  chmodSync(join(bin, 'hc'), 0o755);

  const writeReply = (name: string, stdout: string): void => {
    writeFileSync(join(replies, name), `${stdout}\n`);
  };

  return {
    bin,
    log,
    replies,
    reply: (command, stdout) => {
      writeReply(command, stdout);
    },
    replyGet: (address, stdout) => {
      writeReply(`get-${address}`, stdout);
    },
  };
};
