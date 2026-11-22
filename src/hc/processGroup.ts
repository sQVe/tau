import type { Exec } from '../command.js';

const outputPreviewLength = 200;

export const readProcessGroup = async (exec: Exec, pid: number): Promise<number> => {
  const result = await exec('ps', ['-o', 'pgid=', '-p', String(pid)]);

  if (result.code !== 0 || result.killed) {
    const output = (result.stderr || result.stdout).trim();

    throw new Error(`ps for process ${String(pid)} failed: ${output}`);
  }

  const output = result.stdout.trim();

  if (!/^[1-9]\d*$/u.test(output)) {
    const preview = output.slice(0, outputPreviewLength);

    throw new Error(`ps for process ${String(pid)} printed no process group: ${preview}`);
  }

  return Number(output);
};
