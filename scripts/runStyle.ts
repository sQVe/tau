import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Enables stylePlugin.ts for this command's linter only, so editors keep ordinary diagnostics.

const executable = fileURLToPath(import.meta.resolve('vite-plus/bin'));
const argumentsList = process.argv.slice(2);
const fixing = argumentsList[0] === '--fix';
const paths = fixing ? argumentsList.slice(1) : argumentsList;

const run = (commandArguments: string[], styleEnabled: boolean) => {
  const result = spawnSync(process.execPath, [executable, ...commandArguments], {
    stdio: 'inherit',
    // eslint-disable-next-line node/no-process-env -- Only the child linter enables house style.
    env: { ...process.env, TAU_LINT_STYLE: styleEnabled ? '1' : '0' },
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
};

const lintStatus = run(['lint', '--deny-warnings', ...(fixing ? ['--fix'] : []), ...paths], true);
// Format even when a manual rename or helper move is still needed.
const formatStatus = fixing ? run(['fmt', ...paths], false) : 0;

process.exitCode = lintStatus || formatStatus;
