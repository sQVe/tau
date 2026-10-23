import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { readCheckState } from './identity.js';

it('fails with the Git error when Git is killed while it resolves HEAD', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const shims = await mkdtemp(join(tmpdir(), 'tau-identity-shim-'));
  const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();

  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(shims, { recursive: true, force: true });
  });

  await writeFile(
    join(shims, 'git'),
    `#!/bin/sh\ncase " $* " in *" rev-parse "*) kill -9 $$;; esac\nexec '${realGit}' "$@"\n`,
  );

  await chmod(join(shims, 'git'), 0o755);
  vi.stubEnv('PATH', `${shims}${delimiter}${process.env['PATH'] ?? ''}`);

  const failed = readCheckState(root, undefined);

  await expect(failed).rejects.toThrow('git rev-parse');
  await expect(failed).rejects.not.toThrow('needs a commit at HEAD');
});
