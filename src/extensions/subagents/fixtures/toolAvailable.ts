import { spawnSync } from 'node:child_process';

export const toolAvailable = (command: string) => {
  const available =
    spawnSync(command, ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0;

  if (!available && process.env.CI) {
    throw new Error(`${command} is required in CI but was not found on PATH.`);
  }

  return available;
};
