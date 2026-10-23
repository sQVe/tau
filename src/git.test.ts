import { once } from 'node:events';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { delimiter, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import { findCheckoutRoot, readGit, runGit } from './git.js';

const withWatchdog = async <Value>(pending: Promise<Value>): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Git completion watchdog expired'));
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const installHoldingHook = (root: string, socketPath: string) => {
  const launcher = join(root, '.git/hooks/holder.cjs');

  writeFileSync(
    launcher,
    `
const { spawn } = require('node:child_process');
const { connect } = require('node:net');
if (process.argv[2] === 'hold') {
  const socket = connect(process.argv[3]);
  socket.on('connect', () => {
    socket.write('ready');
    process.send('ready');
  });
  socket.on('end', () => process.exit(0));
  socket.on('error', () => process.exit(1));
} else {
  const holder = spawn(process.execPath, [__filename, 'hold', process.argv[2]], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  holder.once('message', () => {
    holder.disconnect();
    holder.unref();
  });
}
`,
  );

  const hook = join(root, '.git/hooks/post-commit');
  writeFileSync(hook, `#!/bin/sh\nexec '${process.execPath}' '${launcher}' '${socketPath}'\n`);
  chmodSync(hook, 0o755);
};

it('completes after Git exits while a hook descendant holds output open', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const socketPath = join(root, 'holder.sock');
  const ready = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  let connection: Socket | undefined;

  const server = createServer((socket) => {
    connection = socket;

    socket.once('data', () => {
      ready.resolve(undefined);
    });
  });

  onTestFinished(async () => {
    controller.abort();

    if (connection !== undefined && !connection.destroyed) {
      const closed = once(connection, 'close');
      connection.end();
      await withWatchdog(closed);
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  server.listen(socketPath);
  await once(server, 'listening');
  installHoldingHook(root, socketPath);
  writeFileSync(join(root, 'tracked'), 'committed content\n');
  await readGit(root, ['add', 'tracked']);

  const pending = runGit(root, ['commit', '-m', 'test: inherited output'], {
    timeoutMilliseconds: null,
    signal: controller.signal,
  });

  try {
    await withWatchdog(ready.promise);
    const result = await withWatchdog(pending);

    expect(result.exitCode).toBe(0);
    expect(await readGit(root, ['show', 'HEAD:tracked'])).toBe('committed content');
    expect(connection?.destroyed).toBe(false);
  } finally {
    if (connection !== undefined) {
      const closed = once(connection, 'close');
      connection.end();
      await withWatchdog(closed);
    }

    controller.abort();
    await withWatchdog(pending);
  }
}, 15000);

it('preserves raw bytes larger than a pipe buffer', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const bytes = Buffer.alloc(2 * 1024 * 1024);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 256;
  }

  writeFileSync(join(root, 'binary'), bytes);
  const object = await readGit(root, ['hash-object', '-w', 'binary']);
  const result = await runGit(root, ['cat-file', 'blob', object]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.equals(bytes)).toBe(true);
  expect(result.stderr).toBe('');
});

it('preserves hook diagnostics larger than a pipe buffer', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const diagnostic = '€漢字\n'.repeat(200_000);
  writeFileSync(join(root, '.git/diagnostic'), diagnostic);
  const hook = join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\ncat .git/diagnostic >&2\nexit 1\n');
  chmodSync(hook, 0o755);

  const result = await runGit(root, ['commit', '--allow-empty', '-m', 'test: diagnostic']);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe(diagnostic);
  expect(await readGit(root, ['rev-list', '--all', '--count'])).toBe('0');
});

it('resolves a null exit code when Git runs past the timeout', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  // `exec` replaces the shell, so the kill reaches the process that holds the output pipe.
  writeFileSync(join(directory, 'git'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  const result = await runGit(directory, ['remote', 'get-url', 'origin'], {
    timeoutMilliseconds: 50,
  });

  expect(result.exitCode).toBeNull();
});

it('finds the checkout root from a directory inside it', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const nested = join(root, 'src', 'deep');

  mkdirSync(nested, { recursive: true });

  await expect(findCheckoutRoot(nested, 'pr')).resolves.toBe(realpathSync(root));
});

it('names the tool when the directory is not in a Git checkout', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-no-checkout-');

  await expect(findCheckoutRoot(directory, 'pr')).rejects.toThrow(
    `The pr tool needs a Git checkout, and ${directory} is not in one.`,
  );
});

it('resolves the exit code when Git exits before it reads its input', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeFileSync(join(directory, 'git'), '#!/bin/sh\nexit 3\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  const input = 'x'.repeat(4_000_000);
  const result = await runGit(directory, ['cat-file', '--batch'], { input });

  expect(result.exitCode).toBe(3);
});

it('passes the user environment to Git', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'tau.probe');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'from-environment');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const result = await runGit(root, ['config', '--get', 'tau.probe']);

  expect(result.stdout.toString('utf8').trim()).toBe('from-environment');
});

it('resolves a null exit code with the reason when Git cannot start', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-missing-');
  const missing = join(directory, 'absent');

  const result = await runGit(missing, ['status']);

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain('ENOENT');
});

it('resolves a null exit code when the signal aborts Git', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const result = await runGit(root, ['status'], { signal: AbortSignal.abort() });

  expect(result.exitCode).toBeNull();
});

it('adds the environment on top of the scrubbed one', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const other = await createTemporaryRepository(onTestFinished);

  vi.stubEnv('GIT_DIR', join(other, '.git'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const result = await runGit(root, ['rev-parse', '--show-toplevel'], {
    environment: { GIT_OPTIONAL_LOCKS: '0' },
  });

  expect(result.stdout.toString('utf8').trim()).toBe(realpathSync(root));
});

it('uses alternate object directories only when explicitly supplied', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const foreign = await createTemporaryRepository(onTestFinished);
  const content = 'foreign-only content\n';
  const object = await readGit(foreign, ['hash-object', '-w', '--stdin'], { input: content });
  const foreignObjects = join(foreign, '.git', 'objects');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', foreignObjects);

  const inherited = await runGit(root, ['cat-file', 'blob', object]);

  const explicit = await runGit(root, ['cat-file', 'blob', object], {
    environment: { GIT_ALTERNATE_OBJECT_DIRECTORIES: foreignObjects },
  });

  expect(inherited.exitCode).toBe(128);
  expect(inherited.stdout.length).toBe(0);
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stdout.toString('utf8')).toBe(content);
});

it('resolves the trimmed output of a Git command that exits 0', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(readGit(root, ['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true');
});

it('throws with the Git message when Git exits nonzero', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  writeFileSync(join(directory, 'git'), '#!/bin/sh\necho "boom" >&2\nexit 128\n');
  chmodSync(join(directory, 'git'), 0o755);
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

  await expect(readGit(directory, ['fsck'])).rejects.toThrow('git fsck failed: boom');
});

it('throws when Git cannot start', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-git-missing-');

  await expect(readGit(join(directory, 'absent'), ['status'])).rejects.toThrow('ENOENT');
});

it.for([0, 1])(
  'resolves a null exit code with a timeout reason when Git exits with %s after SIGTERM',
  async (exitCode, { onTestFinished }) => {
    const directory = temporaryDirectory(onTestFinished, 'tau-git-shim-');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    writeFileSync(
      join(directory, 'git'),
      `#!/bin/sh\ntrap "exit ${exitCode}" TERM\nwhile :; do sleep 0.05; done\n`,
    );

    chmodSync(join(directory, 'git'), 0o755);
    vi.stubEnv('PATH', `${directory}${delimiter}${process.env['PATH'] ?? ''}`);

    const result = await runGit(directory, ['status'], { timeoutMilliseconds: 300 });

    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('timed out');
  },
);

it('resolves a null exit code for an argument that holds a NUL byte', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const result = await runGit(root, ['rev-parse', 'HEAD:bad\0path']);

  expect(result.exitCode).toBeNull();
  expect(result.stderr).not.toBe('');
});

it('resolves a null exit code for a timeout Node rejects', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const result = await runGit(root, ['status'], { timeoutMilliseconds: -1 });

  expect(result.exitCode).toBeNull();
});
