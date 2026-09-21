import { spawnSync } from 'node:child_process';

export const toolAvailable = (command: string) => {
  const available =
    spawnSync(command, ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;

  // oxlint-disable-next-line node/no-process-env -- CI must run these tests; a silent skip there hides regressions.
  if (!available && process.env.CI) {
    throw new Error(`${command} is required in CI but was not found on PATH.`);
  }

  return available;
};
