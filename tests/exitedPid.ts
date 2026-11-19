import { spawn } from 'node:child_process';

// The pid of a process that has already exited.
export const exitedPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid ?? 0;

  await new Promise((resolve) => {
    child.once('close', resolve);
  });

  return pid;
};
