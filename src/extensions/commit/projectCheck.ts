import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Check the index snapshot: unstaged fixes must not make an incomplete commit pass.
export const checkProject = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  tree: string,
  signal?: AbortSignal,
): Promise<string> => {
  const run = async (command: string, args: string[], directory = cwd) => {
    const result = await pi.exec(command, args, {
      cwd: directory,
      ...(signal ? { signal } : {}),
      timeout: 600_000,
    });
    if (result.code !== 0 || result.killed || signal?.aborted) {
      throw new Error(
        `Project check failed (${command} ${args.join(' ')}):\n${result.stderr}\n${result.stdout}`,
      );
    }
    return result.stdout;
  };
  const root = (await run('git', ['rev-parse', '--show-toplevel'])).trim();
  const manifestPath = await run(
    'git',
    ['ls-tree', '--name-only', tree, '--', 'package.json'],
    root,
  );
  if (!manifestPath.trim()) {
    return 'Project check unavailable: no root package.json.';
  }
  const manifest: unknown = JSON.parse(await run('git', ['show', `${tree}:package.json`], root));
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Project check failed: package.json must be an object.');
  }
  if (
    !('scripts' in manifest) ||
    !manifest.scripts ||
    typeof manifest.scripts !== 'object' ||
    !('check' in manifest.scripts) ||
    typeof manifest.scripts.check !== 'string' ||
    !manifest.scripts.check.trim()
  ) {
    return 'Project check unavailable: no root scripts.check.';
  }
  let manager: string | undefined = 'npm';
  if ('packageManager' in manifest) {
    manager =
      typeof manifest.packageManager === 'string'
        ? manifest.packageManager.split('@')[0]
        : undefined;
  }
  if (!manager || !['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) {
    throw new Error(
      'Project check failed: unsupported packageManager. Use npm, pnpm, yarn, or bun.',
    );
  }

  const temporary = await mkdtemp(join(tmpdir(), 'tau-project-check-'));
  const candidate = join(temporary, 'candidate');
  try {
    await run('git', ['clone', '--shared', '--no-checkout', '--', root, candidate]);
    await run('git', ['read-tree', tree], candidate);
    await run('git', ['checkout-index', '--all'], candidate);
    // ponytail: reuse root dependencies; workspace packages needing separate installs must prepare them separately.
    const dependencies = join(root, 'node_modules');
    if (
      await access(dependencies).then(
        () => true,
        () => false,
      )
    ) {
      await symlink(dependencies, join(candidate, 'node_modules'), 'dir');
    }
    await run(manager, ['run', 'check'], candidate);
    if ((await run('git', ['diff', '--name-only', tree, '--'], candidate)).trim()) {
      throw new Error(
        'Project check changed tracked files. Run it locally, review the changes, and retry commit.',
      );
    }
    return `Project check passed: ${manager} run check on ${tree}.`;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
