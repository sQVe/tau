import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hasTypeScriptFiles = (path) => {
  try {
    const entries = readdirSync(path, { withFileTypes: true });

    return entries.some((entry) => {
      if (entry.isDirectory()) {
        return hasTypeScriptFiles(join(path, entry.name));
      }

      return entry.isFile() && entry.name.endsWith('.ts');
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
};

const hasInputs = ['extensions', 'src', 'test', 'tests'].some((path) => hasTypeScriptFiles(path));

if (!hasInputs) {
  process.stdout.write('tau: no TypeScript inputs yet; skipping typecheck\n');
  process.exit(0);
}

const result = spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
