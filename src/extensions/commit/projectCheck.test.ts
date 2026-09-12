import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import * as preparation from './preparation.js';
import { createCandidateChecks } from './projectCheck.js';
import { assertNoPendingRecovery } from './recovery.js';
import * as recovery from './recovery.js';

const execute = promisify(execFile);
const directories: string[] = [];
const git = async (root: string, arguments_: string[]) =>
  (await execute('git', arguments_, { cwd: root })).stdout.trim();
const pi: Pick<ExtensionAPI, 'exec'> = {
  async exec(command, arguments_, options) {
    const result = await execute(command, arguments_, { cwd: options?.cwd });

    return { ...result, code: 0, killed: false };
  },
};
const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-in-place-check-'));
  const temporary = await mkdtemp(join(tmpdir(), 'tau-check-message-'));
  directories.push(root, temporary);

  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(root, 'file'), 'base');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);

  return { root, temporary };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('checks staged scripts and workspace sources in place then restores raw work and staging', async () => {
  const { root, temporary } = await repository();
  await mkdir(join(root, 'apps/web/node_modules/@test'), { recursive: true });
  await mkdir(join(root, 'packages/utils'), { recursive: true });
  await symlink('../../../../packages/utils', join(root, 'apps/web/node_modules/@test/utils'));
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'packages/utils/value'), 'staged workspace');
  await writeFile(
    join(root, 'tau.json'),
    JSON.stringify({
      check: [process.execPath, 'check.cjs'],
      checkMessage: [process.execPath, 'message.cjs'],
    }),
  );
  await writeFile(
    join(root, 'check.cjs'),
    `const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.equal(process.cwd(), ${JSON.stringify(root)}); assert.equal(fs.readFileSync('file', 'utf8'), 'staged'); assert.equal(fs.readFileSync('apps/web/node_modules/@test/utils/value', 'utf8'), 'staged workspace'); assert.equal(fs.existsSync('untracked'), false); assert.equal(fs.existsSync('deleted'), false);`,
  );
  await writeFile(
    join(root, 'message.cjs'),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('file', 'utf8'), 'staged');",
  );
  await writeFile(join(root, 'deleted'), 'base deletion');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'setup']);
  await writeFile(join(root, 'file'), 'staged');
  await git(root, ['rm', 'deleted']);
  await git(root, ['add', 'file']);
  const tree = await git(root, ['write-tree']);
  await writeFile(join(root, 'file'), 'raw\r\nworking');
  await chmod(join(root, 'file'), 0o600);
  await writeFile(join(root, 'deleted'), 'working resurrection');
  await writeFile(join(root, 'untracked'), 'user data');
  await writeFile(join(root, 'check.cjs'), "throw new Error('unstaged script');");
  await writeFile(join(root, 'tau.json'), '{"check":["false"]}');
  await writeFile(join(root, 'packages/utils/value'), 'working workspace');
  await writeFile(join(root, '.git/info/exclude'), 'deleted\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\nworking-only-ignore\n');
  await writeFile(join(root, 'working-only-ignore'), 'ignored user bytes');
  const index = await readFile(join(root, '.git/index'));
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await checks.checkProject();
  await checks.checkMessage('feat: check\n');

  expect(await readFile(join(root, 'file'), 'utf8')).toBe('raw\r\nworking');
  expect((await lstat(join(root, 'file'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(root, 'deleted'), 'utf8')).toBe('working resurrection');
  expect(await readFile(join(root, 'untracked'), 'utf8')).toBe('user data');
  expect(await readFile(join(root, 'packages/utils/value'), 'utf8')).toBe('working workspace');
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
  expect((await lstat(join(root, 'apps/web/node_modules/@test/utils'))).isSymbolicLink()).toBe(
    true,
  );
  expect(await readFile(join(root, 'working-only-ignore'), 'utf8')).toBe('ignored user bytes');
});

it.each(['failure', 'file', 'stage', 'new-file'])(
  'preserves originals and checker output after %s',
  async (outcome) => {
    const { root, temporary } = await repository();
    let action = 'process.exitCode = 1';

    if (outcome === 'file' || outcome === 'stage') {
      action = "require('node:fs').writeFileSync('file', 'checker output')";
    } else if (outcome === 'new-file') {
      action = "require('node:fs').writeFileSync('new-file', 'checker output')";
    }

    if (outcome === 'stage') {
      action += "; require('node:child_process').execFileSync('git', ['add', 'file'])";
    }

    await writeFile(
      join(root, 'tau.json'),
      JSON.stringify({ check: [process.execPath, '-e', action] }),
    );
    await writeFile(join(root, 'file'), 'staged');
    await git(root, ['add', '.']);
    const tree = await git(root, ['write-tree']);
    const index = await readFile(join(root, '.git/index'));
    await writeFile(join(root, 'file'), 'original working');
    const checks = await createCandidateChecks(pi, root, tree, temporary);

    await expect(checks.checkProject()).rejects.toThrow(
      outcome === 'failure' ? /Project check failed/ : /Pending recovery/,
    );
    const expected: Record<string, string> = {
      failure: 'original working',
      file: 'checker output',
      stage: 'checker output',
      'new-file': 'staged',
    };
    expect(await readFile(join(root, 'file'), 'utf8')).toBe(expected[outcome]);
    const pending = await assertNoPendingRecovery(join(root, '.git')).then(
      () => false,
      () => true,
    );
    expect(pending).toBe(outcome !== 'failure');
    const names = await readdir(join(root, '.git/tau-recovery'));
    const name = names.find((entry) => entry.startsWith('prepare-'))!;
    const original: unknown = JSON.parse(
      await readFile(join(root, '.git/tau-recovery', name, 'working.json'), 'utf8'),
    );
    expect(original).toMatchObject({
      file: { content: Buffer.from('original working').toString('base64') },
    });
    expect(await git(root, ['show', ':file'])).toBe(
      outcome === 'stage' ? 'checker output' : 'staged',
    );
    expect((await readFile(join(root, '.git/index'))).equals(index)).toBe(outcome !== 'stage');
    const newFile = await readFile(join(root, 'new-file'), 'utf8').catch(() => null);
    expect(newFile).toBe(outcome === 'new-file' ? 'checker output' : null);
  },
);

it.each(['staging', 'untracked'])(
  'refuses concurrent %s between projection and backup',
  async (collision) => {
    const { root, temporary } = await repository();
    await writeFile(
      join(root, 'tau.json'),
      JSON.stringify({
        check: [process.execPath, '-e', "require('node:fs').writeFileSync('.git/ran', 'ran')"],
      }),
    );
    await git(root, ['add', '.']);
    const tree = await git(root, ['write-tree']);
    let injected = false;
    let index: Buffer | undefined;
    const concurrent: Pick<ExtensionAPI, 'exec'> = {
      async exec(command, arguments_, options) {
        if (!injected && arguments_.includes('--absolute-git-dir')) {
          injected = true;
          await writeFile(join(root, 'concurrent'), 'new user work');
          if (collision === 'staging') {
            await git(root, ['add', 'concurrent']);
          }
          index = await readFile(join(root, '.git/index'));
        }

        return pi.exec(command, arguments_, options);
      },
    };
    const checks = await createCandidateChecks(concurrent, root, tree, temporary);

    await expect(checks.checkProject()).rejects.toThrow(/changed|projection/);
    expect(await readFile(join(root, 'concurrent'), 'utf8')).toBe('new user work');
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    await expect(readFile(join(root, '.git/ran'))).rejects.toThrow(/ENOENT/);
  },
);

it('reads many staged binary blobs with one native batch', async () => {
  const { root, temporary } = await repository();
  const binary = Buffer.from([0, 255, 10, 13, 0, 128]);
  await writeFile(
    join(root, 'tau.json'),
    JSON.stringify({
      check: [
        process.execPath,
        '-e',
        "const fs = require('node:fs'); const assert = require('node:assert/strict'); for (let i = 0; i < 80; i++) assert.deepEqual(fs.readFileSync('binary-' + i + '\\nfile'), Buffer.from([0, 255, 10, 13, 0, 128])); assert.equal(fs.readFileSync('empty').length, 0);",
      ],
    }),
  );
  await writeFile(join(root, 'empty'), '');
  await Promise.all(
    Array.from({ length: 80 }, (_, position) =>
      writeFile(join(root, `binary-${position}\nfile`), binary),
    ),
  );
  await git(root, ['add', '.']);
  const tree = await git(root, ['write-tree']);
  const reads = vi.spyOn(preparation, 'gitBytes');
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await checks.checkProject();

  expect(reads.mock.calls.filter(([, arguments_]) => arguments_[0] === 'cat-file')).toHaveLength(1);
  expect(await readFile(join(root, 'binary-79\nfile'))).toEqual(binary);
});

it('rejects aggregate staged data over 100 MiB before reading blob payloads or hiding', async () => {
  const { root, temporary } = await repository();
  await writeFile(join(root, 'tau.json'), JSON.stringify({ check: ['true'] }));
  await git(root, ['add', '.']);
  await writeFile(join(root, '.git/large-blob'), Buffer.alloc(11 * 1024 * 1024, 65));
  const object = await git(root, ['hash-object', '-w', '.git/large-blob']);

  for (let position = 0; position < 10; position += 1) {
    await git(root, [
      'update-index',
      '--add',
      '--cacheinfo',
      '100644',
      object,
      `large-${position}`,
    ]);
  }

  const tree = await git(root, ['write-tree']);
  const index = await readFile(join(root, '.git/index'));
  const reads = vi.spyOn(preparation, 'gitBytes');
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await expect(checks.checkProject()).rejects.toThrow(/100 MiB/);
  expect(reads.mock.calls.filter(([, arguments_]) => arguments_[0] === 'cat-file')).toHaveLength(0);
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('base');
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
  await expect(lstat(join(root, '.git/tau-recovery/pending'))).rejects.toThrow(/ENOENT/);
});

it('allows new artifacts covered by the original ignore rules', async () => {
  const { root, temporary } = await repository();
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  await writeFile(
    join(root, 'tau.json'),
    JSON.stringify({
      check: [
        process.execPath,
        '-e',
        "const fs = require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/result', 'build output');",
      ],
    }),
  );
  await git(root, ['add', '.']);
  const tree = await git(root, ['write-tree']);
  await writeFile(join(root, 'file'), 'raw\r\nworking');
  const index = await readFile(join(root, '.git/index'));
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await checks.checkProject();

  expect(await readFile(join(root, 'dist/result'), 'utf8')).toBe('build output');
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('raw\r\nworking');
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
  await assertNoPendingRecovery(join(root, '.git'));
});

it.each(['status', 'diff'])(
  'read-only git %s preserves exact staging through a check window',
  async (command) => {
    const { root, temporary } = await repository();
    await writeFile(join(root, 'tau.json'), JSON.stringify({ check: ['git', command] }));
    await git(root, ['add', '.']);
    const tree = await git(root, ['write-tree']);
    await writeFile(join(root, 'file'), 'raw\r\nworking');
    await chmod(join(root, 'file'), 0o600);
    const index = await readFile(join(root, '.git/index'));
    const checks = await createCandidateChecks(pi, root, tree, temporary);

    await checks.checkProject();

    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('raw\r\nworking');
    expect((await lstat(join(root, 'file'))).mode & 0o777).toBe(0o600);
    await assertNoPendingRecovery(join(root, '.git'));
  },
);

it('reports both checker and restoration failures while retaining recovery', async () => {
  const { root, temporary } = await repository();
  await writeFile(
    join(root, 'tau.json'),
    JSON.stringify({
      check: [
        process.execPath,
        '-e',
        "console.error('compiler diagnostic'); process.exitCode = 1;",
      ],
    }),
  );
  await git(root, ['add', '.']);
  const tree = await git(root, ['write-tree']);
  await writeFile(join(root, 'file'), 'original raw work');
  const hide = recovery.hidePending;
  vi.spyOn(recovery, 'hidePending').mockImplementation(async (...arguments_) => {
    const window = await hide(...arguments_);

    return { ...window, restore: () => Promise.reject(new Error('injected restoration failure')) };
  });
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await expect(checks.checkProject()).rejects.toThrow(
    /compiler diagnostic[\s\S]*injected restoration failure[\s\S]*tau-recovery/,
  );
  const name = await readFile(join(root, '.git/tau-recovery/pending/archive'), 'utf8');
  const saved: unknown = JSON.parse(
    await readFile(join(root, '.git/tau-recovery', name, 'working.json'), 'utf8'),
  );
  expect(saved).toMatchObject({
    file: { content: Buffer.from('original raw work').toString('base64') },
  });
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('base');
  await expect(assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
});

it('keeps staged-rule artifacts after restoring different working ignore rules', async () => {
  const { root, temporary } = await repository();
  await writeFile(join(root, '.gitignore'), 'dist/\n*.tsbuildinfo\n');
  await writeFile(
    join(root, 'tau.json'),
    JSON.stringify({
      check: [
        process.execPath,
        '-e',
        "const fs = require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/result', 'build output'); fs.writeFileSync('project.tsbuildinfo', 'metadata');",
      ],
    }),
  );
  await git(root, ['add', '.']);
  const tree = await git(root, ['write-tree']);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/installed'), 'installed dependency');
  await writeFile(join(root, 'file'), 'original working');
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await checks.checkProject();

  expect(await readFile(join(root, 'dist/result'), 'utf8')).toBe('build output');
  expect(await readFile(join(root, 'project.tsbuildinfo'), 'utf8')).toBe('metadata');
  expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
  expect(await readFile(join(root, 'node_modules/installed'), 'utf8')).toBe('installed dependency');
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('original working');
  await assertNoPendingRecovery(join(root, '.git'));
});

it.each(['create', 'change', 'external'])(
  'rejects an ignore-file %s that hides new checker output',
  async (mutation) => {
    const { root, temporary } = await repository();
    if (mutation !== 'create') {
      await writeFile(join(root, '.gitignore'), '# original rules\n');
    }
    const ignoreFile = mutation === 'external' ? '.git/info/exclude' : '.gitignore';
    await writeFile(
      join(root, 'tau.json'),
      JSON.stringify({
        check: [
          process.execPath,
          '-e',
          `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ignoreFile)}, '*\\n'); fs.writeFileSync('new-output', 'checker output');`,
        ],
      }),
    );
    await git(root, ['add', '.']);
    const tree = await git(root, ['write-tree']);
    const index = await readFile(join(root, '.git/index'));
    await writeFile(join(root, 'file'), 'original working');
    const checks = await createCandidateChecks(pi, root, tree, temporary);

    await expect(checks.checkProject()).rejects.toThrow(/Pending recovery/);
    expect(await readFile(join(root, 'new-output'), 'utf8')).toBe('checker output');
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    await expect(assertNoPendingRecovery(join(root, '.git'))).rejects.toThrow(/recovery/i);
  },
);

it('refuses file-directory transitions before hiding any working file', async () => {
  const { root, temporary } = await repository();
  await writeFile(join(root, 'tau.json'), JSON.stringify({ check: ['true'] }));
  await git(root, ['add', '.']);
  const tree = await git(root, ['write-tree']);
  await rm(join(root, 'file'));
  await mkdir(join(root, 'file'));
  await writeFile(join(root, 'file/user'), 'user bytes');
  const index = await readFile(join(root, '.git/index'));
  const checks = await createCandidateChecks(pi, root, tree, temporary);

  await expect(checks.checkProject()).rejects.toThrow(/Unsupported working path/);
  expect(await readFile(join(root, 'file/user'), 'utf8')).toBe('user bytes');
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
});
