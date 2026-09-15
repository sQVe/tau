import type * as fileSystem from 'node:fs/promises';
import { chmod, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import {
  temporaryDirectories,
  createCommitTool,
  realChecker,
  useCheckerExec,
  runCommand,
  git,
  createTemporaryRepository,
  writeRepositoryFile,
  getStoredCommitMessage,
  commitContext,
  noUiContext,
  executeCommit,
  fakeCommit,
} from '../../../tests/commitTool.js';
import * as checker from './checker.js';
import type { reviewComments } from './commentReview.js';
import { createCommitTool as createReviewedCommitTool } from './tool.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return {
    ...original,
    rename: vi.fn<typeof rename>(original.rename),
    rm: vi.fn<typeof rm>(original.rm),
  };
});

const cleanupFailureFixture = async (
  outcome: 'checker failure' | 'ordinary cancellation' | 'prepared cancellation',
) => {
  const directory = await createTemporaryRepository();
  await writeRepositoryFile(
    directory,
    'tau.json',
    JSON.stringify({ checkMessage: ['message-command'] }),
  );
  await writeRepositoryFile(directory, 'second', 'value');
  const leftovers: string[] = [];
  let checkCount = 0;
  const controller = new AbortController();
  const originalFilesystem = await vi.importActual<typeof fileSystem>('node:fs/promises');
  const exec: ExtensionAPI['exec'] = (command, arguments_, options) => {
    if (command === 'message-command') {
      checkCount += 1;
      leftovers.push(dirname(arguments_.at(-1)!));
      vi.mocked(rm).mockImplementation(async (path, removalOptions) => {
        if (leftovers.includes(String(path))) {
          throw new Error('cleanup denied');
        }

        await originalFilesystem.rm(path, removalOptions);
      });

      if (checkCount === 2 && outcome !== 'checker failure') {
        controller.abort();
      }

      if (checkCount === 2 && outcome === 'prepared cancellation') {
        vi.mocked(rename).mockImplementation(async (source, destination) => {
          if (String(source).endsWith('/index.lock')) {
            throw new Error('index cleanup denied');
          }

          await originalFilesystem.rename(source, destination);
        });
      }

      return Promise.resolve({
        code: checkCount === 2 && outcome === 'checker failure' ? 1 : 0,
        killed: false,
        stdout: '',
        stderr: 'primary checker failure',
      });
    }

    return runCommand(command, arguments_, options?.cwd ?? directory);
  };
  useCheckerExec(exec);
  const tool = createReviewedCommitTool({ exec }, async () => ({ findings: [] }));
  const cleanup = async () => {
    vi.mocked(rename).mockImplementation(originalFilesystem.rename);
    vi.mocked(rm).mockImplementation(originalFilesystem.rm);
    await Promise.all(leftovers.map((path) => rm(path, { recursive: true, force: true })));
  };

  return { directory, controller, tool, cleanup };
};

describe('message policy', () => {
  it('checks normalized requested bytes once without repeating candidate work', async () => {
    const directory = await createTemporaryRepository();
    const context = commitContext(directory);
    await writeFile(join(directory, 'generated'), 'prepared');
    const messages: string[] = [];
    const candidates: string[] = [];
    const messagePaths: string[] = [];
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const exec = vi.fn<ExtensionAPI['exec']>(async (command, arguments_, options) => {
      if (command === 'node' && arguments_[0] === 'message.cjs') {
        messagePaths.push(arguments_.at(-1)!);
        messages.push(await readFile(arguments_.at(-1)!, 'utf8'));
        candidates.push(options!.cwd!);
      }

      return runCommand(command, arguments_, options?.cwd ?? directory, options?.signal);
    });
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'printf prepared > generated'],
        check: [
          'node',
          '-e',
          "require('node:assert').equal(require('node:fs').readFileSync('generated','utf8'),'prepared')",
        ],
        checkMessage: ['node', 'message.cjs', ''],
      }),
    );
    await writeRepositoryFile(
      directory,
      'message.cjs',
      "require('node:assert').equal(process.argv[2], '');",
    );
    useCheckerExec(exec);
    const tool = createReviewedCommitTool({ exec }, review);
    const result = await tool.execute(
      'messages',
      {
        groups: [
          {
            files: ['tau.json', 'message.cjs', 'generated'],
            subject: 'feat: original',
            body: 'Original\rbody',
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(messages).toEqual(['feat: original\n\nOriginal\nbody\n']);
    expect(await getStoredCommitMessage(directory)).toBe(messages[0]);
    expect(result.details.groups[0]).toMatchObject({
      subject: 'feat: original',
      body: 'Original\nbody\n',
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.filter(([, arguments_]) => arguments_.includes('clone'))).toHaveLength(
      0,
    );
    expect(
      exec.mock.calls.filter(
        ([command, arguments_]) => command === 'env' && arguments_.includes('sh'),
      ),
    ).toHaveLength(1);
    expect(
      exec.mock.calls.filter(
        ([command, arguments_]) => command === 'node' && arguments_[0] === '-e',
      ),
    ).toHaveLength(1);
    expect(new Set(candidates).size).toBe(1);
    await expect(readFile(messagePaths[0]!)).rejects.toThrow(/ENOENT/);
    expect(candidates).toEqual([directory]);
    expect(await readdir(directory)).toContain('tau.json');
  });

  it('uses staged skip only for final commit and leaves human hooks intact', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ hooks: 'skip', checkMessage: ['node', 'message.cjs'] }),
    );
    await writeRepositoryFile(
      directory,
      'message.cjs',
      "require('node:assert').ok(require('node:fs').readFileSync(process.argv[2], 'utf8').startsWith('feat:'));",
    );
    await git(directory, ['add', 'tau.json', 'message.cjs']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ hooks: 'run', checkMessage: ['false'] }),
    );
    await writeRepositoryFile(directory, 'message.cjs', 'process.exit(1)');
    await git(directory, ['config', 'core.hooksPath', '.human-hooks']);
    const hooks = [
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'reference-transaction',
    ];
    for (const hook of hooks) {
      await writeRepositoryFile(
        directory,
        `.human-hooks/${hook}`,
        `#!/bin/sh\nprintf '${hook}\\n' >> .git/hooks.log\n`,
      );
      await chmod(join(directory, `.human-hooks/${hook}`), 0o755);
    }
    await writeRepositoryFile(directory, 'requested', 'value');
    let emptyHooks = '';
    const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) => {
      const override = arguments_.find((argument) => argument.startsWith('core.hooksPath='));
      if (override) {
        emptyHooks = override.slice('core.hooksPath='.length);
      }

      return runCommand(command, arguments_, options?.cwd ?? directory);
    });
    const tool = createReviewedCommitTool({ exec }, async () => ({ findings: [] }));
    const result = await tool.execute(
      'skip',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      undefined,
      undefined,
      noUiContext(directory),
    );

    expect(JSON.stringify(result.content)).toContain('Git hooks: skip');
    expect(emptyHooks).not.toBe('');
    expect(
      exec.mock.calls
        .filter(([, arguments_]) =>
          arguments_.some((argument) => argument.startsWith('core.hooksPath=')),
        )
        .every(([, arguments_]) => arguments_.includes('commit')),
    ).toBe(true);
    await expect(readdir(emptyHooks)).rejects.toThrow(/ENOENT/);
    const recoveryHooks = await readFile(join(directory, '.git/hooks.log'), 'utf8');
    expect(
      recoveryHooks
        .trim()
        .split('\n')
        .every((hook) => hook === 'reference-transaction'),
    ).toBe(true);
    expect(await git(directory, ['config', '--get', 'core.hooksPath'])).toBe('.human-hooks\n');
    await git(directory, ['commit', '--allow-empty', '-m', 'test: human']);
    const log = await readFile(join(directory, '.git/hooks.log'), 'utf8');
    for (const hook of hooks) {
      expect(log).toContain(hook);
    }
  });

  it('does not let working skip disable staged default hooks', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'tau.json', '{}');
    await git(directory, ['add', 'tau.json']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    await writeRepositoryFile(directory, 'tau.json', '{"hooks":"skip"}');
    await writeRepositoryFile(
      directory,
      '.git/hooks/prepare-commit-msg',
      '#!/bin/sh\necho must run >&2\nexit 1\n',
    );
    await chmod(join(directory, '.git/hooks/prepare-commit-msg'), 0o755);
    await writeRepositoryFile(directory, 'requested', 'value');

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/must run/);
  });

  it('reports missing message validation and preserves normalized whitespace without Git cleanup', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: requested  ', body: '# keep  \r\n\r\n' }],
    });

    expect(await getStoredCommitMessage(directory)).toBe('feat: requested  \n\n# keep  \n\n');
    expect(JSON.stringify(result.content)).toContain('Message check unavailable');
    expect(JSON.stringify(result.content)).toContain('Git hooks: run');
  });

  it('returns message failures without UI and accepts correction in a new call', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ checkMessage: ['node', 'message.cjs'] }),
    );
    await writeRepositoryFile(
      directory,
      'message.cjs',
      "if (!require('node:fs').readFileSync(process.argv[2], 'utf8').includes('fixed')) { console.error('message diagnostic'); process.exit(1); }",
    );
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? directory),
    );
    const tool = createReviewedCommitTool({ exec }, review);
    const { context, custom, editor } = fakeCommit();
    context.cwd = directory;
    const input = { groups: [{ files: ['tau.json', 'message.cjs'], subject: 'feat: message' }] };

    for (const hasUI of [true, false]) {
      context.hasUI = hasUI;
      await expect(
        tool.execute('fail', input, undefined, undefined, context as never),
      ).rejects.toThrow(/Message check failed.*message diagnostic/s);
      expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
      expect((await git(directory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
    }

    expect(custom).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    await tool.execute(
      'retry',
      {
        groups: [{ ...input.groups[0]!, body: 'fixed' }],
      },
      undefined,
      undefined,
      context as never,
    );
    expect(await getStoredCommitMessage(directory)).toBe('feat: message\n\nfixed\n');
  });

  it.each([
    'message',
    'tracked',
    'tracked-fail',
    'tracked-killed',
    'staged',
    'untracked',
    'fifo',
    'message-fifo',
    'killed',
    'abort',
    'throw',
  ] as const)('hard-stops message checkers for %s and retains pending work', async (outcome) => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ checkMessage: ['message-command'] }),
    );
    const controller = new AbortController();
    let candidate = '';
    let message = '';
    const custom = vi.fn<() => Promise<string>>().mockResolvedValue('body');
    const exec: ExtensionAPI['exec'] = async (command, arguments_, options) => {
      if (command !== 'message-command') {
        return runCommand(command, arguments_, options?.cwd ?? directory, options?.signal);
      }
      candidate = options!.cwd!;
      message = arguments_.at(-1)!;
      expect(options).toMatchObject({ signal: controller.signal, timeout: 600_000 });
      if (outcome === 'message') {
        await writeFile(message, 'rewritten');
      }

      if (outcome.startsWith('tracked') || outcome === 'staged') {
        await writeFile(join(candidate, 'tau.json'), '{}');
      }
      if (outcome === 'staged') {
        await git(candidate, ['add', 'tau.json']);
        await git(candidate, ['checkout-index', '--all', '--force']);
      }
      if (outcome === 'untracked') {
        await writeFile(join(candidate, 'contamination'), 'bad');
      }

      if (outcome === 'fifo') {
        await runCommand('mkfifo', ['contamination'], candidate);
      }

      if (outcome === 'message-fifo') {
        await rm(message);
        await runCommand('mkfifo', [message], candidate);
      }

      if (outcome === 'abort') {
        controller.abort();
      }

      if (outcome === 'throw') {
        throw new Error('spawn failed');
      }

      return {
        code: outcome === 'tracked-fail' ? 1 : 0,
        killed: outcome === 'killed' || outcome === 'tracked-killed',
        stdout: '',
        stderr: 'killed diagnostic',
      };
    };
    useCheckerExec(exec);
    const tool = createCommitTool({ exec });
    const result = await tool
      .execute(
        'mutation',
        { groups: [{ files: ['tau.json'], subject: 'feat: policy' }] },
        controller.signal,
        undefined,
        { cwd: directory, hasUI: true, ui: { custom } } as never,
      )
      .then(
        (value) => JSON.stringify(value.content),
        (error: unknown) => String(error),
      );
    const expected: Record<string, RegExp> = {
      abort: /Commit cancelled/,
      killed: /Message check.*killed diagnostic/s,
      throw: /Pending recovery/,
    };
    expect(result).toMatch(expected[outcome] ?? /Message check changed|Checker changed/);
    expect(custom).not.toHaveBeenCalled();
    expect(candidate).not.toBe('');
    expect(candidate).toBe(directory);
    const pending = !['message', 'message-fifo', 'killed', 'abort'].includes(outcome);
    const reservation = await readdir(join(directory, '.git/tau-recovery'));
    expect(reservation.includes('pending')).toBe(pending);
    const retainsOutput = pending || outcome === 'message' || outcome === 'message-fifo';

    if (retainsOutput) {
      temporaryDirectories.push(dirname(message));
    }

    const retainedMessage = await readdir(dirname(message)).then(
      () => true,
      () => false,
    );
    expect(retainedMessage).toBe(retainsOutput);
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe(
      pending ? 'tau.json\n' : '',
    );
  });

  it('undoes hook message rewrites instead of accepting unchecked bytes', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    await writeRepositoryFile(
      directory,
      '.git/hooks/commit-msg',
      '#!/bin/sh\nprintf "rewritten\\n" >> "$1"\n',
    );
    await chmod(join(directory, '.git/hooks/commit-msg'), 0o755);

    await expect(
      executeCommit(directory, { groups: [{ files: ['requested'], subject: 'feat: requested' }] }),
    ).rejects.toThrow(/hook changed.*message.*undone/is);
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('0\n');
  });

  it('keeps earlier group hashes when message validation stops a batch', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ checkMessage: ['node', 'message.cjs'] }),
    );
    await writeRepositoryFile(
      directory,
      'message.cjs',
      "if (require('node:fs').readFileSync(process.argv[2], 'utf8').includes('second')) process.exit(1);",
    );
    await writeRepositoryFile(directory, 'second', 'value');
    const tool = createReviewedCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      async () => ({ findings: [] }),
    );
    const failure = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['tau.json', 'message.cjs'], subject: 'feat: first' },
            { files: ['second'], subject: 'feat: second' },
          ],
        },
        undefined,
        undefined,
        noUiContext(directory),
      )
      .catch((error: unknown) => String(error));

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    expect(failure).toContain(`Group 1/2: ${head} feat: first`);
    expect(failure).toContain('Group 2/2: Message check failed');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('unstages ordinary groups when the checked message file is changed or deleted', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ checkMessage: ['message-command'] }),
    );
    for (const mutation of ['change', 'delete', 'fifo', 'symlink']) {
      let messagePath = '';
      const exec: ExtensionAPI['exec'] = (command, arguments_, options) => {
        if (command === 'message-command') {
          messagePath = arguments_.at(-1)!;

          return Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' });
        }

        return runCommand(command, arguments_, options?.cwd ?? directory);
      };
      useCheckerExec(exec);
      const review = async () => {
        if (mutation === 'change') {
          await writeFile(messagePath, 'tampered');
        } else {
          const replacement = join(dirname(messagePath), 'replacement');
          await rename(messagePath, replacement);
          if (mutation === 'fifo') {
            await runCommand('mkfifo', [messagePath], directory);
          }
          if (mutation === 'symlink') {
            await symlink(replacement, messagePath);
          }
        }

        return { findings: [] };
      };
      const tool = createReviewedCommitTool({ exec }, review);

      await expect(
        tool.execute(
          'tamper',
          { groups: [{ files: ['tau.json'], subject: 'feat: policy' }] },
          undefined,
          undefined,
          commitContext(directory),
        ),
      ).rejects.toThrow(/Message file changed|ENOENT/);
      expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
      await expect(readFile(messagePath)).rejects.toThrow(/ENOENT/);
    }
  });

  it('preserves successful hashes and primary checker failures when temporary cleanup fails', async () => {
    const { directory, tool, cleanup } = await cleanupFailureFixture('checker failure');

    try {
      const result = await tool.execute(
        'first',
        { groups: [{ files: ['tau.json'], subject: 'feat: first' }] },
        undefined,
        undefined,
        noUiContext(directory),
      );
      const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
      expect(result.details.groups[0]?.sha).toBe(head);
      expect(JSON.stringify(result.content)).toContain('cleanup denied');
      await expect(
        tool.execute(
          'second',
          { groups: [{ files: ['second'], subject: 'feat: second' }] },
          undefined,
          undefined,
          noUiContext(directory),
        ),
      ).rejects.toThrow(/primary checker failure.*cleanup denied/s);
      expect((await git(directory, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    } finally {
      await cleanup();
    }
  });

  it.each(['ordinary cancellation', 'prepared cancellation'] as const)(
    'preserves successful hashes and primary errors after %s when temporary cleanup fails',
    async (outcome) => {
      const { directory, controller, tool, cleanup } = await cleanupFailureFixture(outcome);

      try {
        // Cancellation needs a committed policy, but does not depend on the checker failure case.
        await git(directory, ['add', 'tau.json']);
        await git(directory, ['commit', '-m', 'test: baseline']);

        const prepared = outcome === 'prepared cancellation';

        if (prepared) {
          await writeRepositoryFile(
            directory,
            'tau.json',
            JSON.stringify({ prepare: ['true'], checkMessage: ['message-command'] }),
          );
        }
        const name = prepared ? 'prepared' : 'ordinary';
        await writeRepositoryFile(directory, name, 'value');
        const failure = await tool
          .execute(
            'cancelled-batch',
            {
              groups: [
                { files: [name], subject: `feat: ${name}` },
                { files: ['second'], subject: 'feat: second' },
              ],
            },
            controller.signal,
            undefined,
            noUiContext(directory),
          )
          .catch((error: unknown) => String(error));
        const committed = (await git(directory, ['rev-parse', 'HEAD'])).trim();

        expect(failure).toContain(`Group 1/2: ${committed} feat: ${name}`);
        expect(failure).toContain('cleanup denied');
        expect(failure).toContain(prepared ? 'index cleanup denied' : 'Commit cancelled');
      } finally {
        await cleanup();
      }
    },
  );

  it('restores after real message subprocess termination and cancellation', async () => {
    const directory = await createTemporaryRepository();
    const processFile = join(directory, '.git/checker-process');
    for (const abort of [false, true]) {
      const controller = new AbortController();
      await rm(processFile, { force: true });
      await writeRepositoryFile(
        directory,
        'tau.json',
        JSON.stringify({ checkMessage: ['node', 'message.cjs', processFile] }),
      );
      await writeRepositoryFile(
        directory,
        'message.cjs',
        `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); ${abort ? 'setInterval(() => {}, 1000)' : "process.kill(process.pid, 'SIGTERM')"};`,
      );
      let candidate = '';
      let message = '';
      const custom = vi.fn<() => never>(() => {
        throw new Error('Unexpected approval UI');
      });
      vi.spyOn(checker, 'runChecker').mockImplementation(async (command, root, signal) => {
        const pending = realChecker(command, root, signal);
        if (command[0] === 'node') {
          candidate = root;
          message = command.at(-1)!;
          if (abort) {
            try {
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const ready = await readFile(processFile).catch(() => null);
                if (ready) {
                  break;
                }
                await delay(20);
              }
            } finally {
              controller.abort();
            }
          }
        }

        return pending;
      });
      const tool = createCommitTool({
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      });
      const result = await tool
        .execute(
          'process',
          { groups: [{ files: ['tau.json', 'message.cjs'], subject: 'feat: message' }] },
          controller.signal,
          undefined,
          { cwd: directory, hasUI: true, ui: { custom } } as never,
        )
        .then(
          (value) => JSON.stringify(value.content),
          (error: unknown) => String(error),
        );
      expect(result).toMatch(abort ? /Commit cancelled/ : /Message check failed/);
      expect(custom).not.toHaveBeenCalled();
      const processId = Number(await readFile(processFile, 'utf8'));
      expect(() => process.kill(processId, 0)).toThrow(/ESRCH/);
      expect(candidate).toBe(directory);
      await expect(readFile(join(candidate, '.git/tau-recovery/pending/archive'))).rejects.toThrow(
        /ENOENT/,
      );
      await expect(readFile(message)).rejects.toThrow(/ENOENT/);
      expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    }
  });

  it('rejects replacement message symlinks instead of accepting identical bytes', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({ checkMessage: ['message-command'] }),
    );
    const exec: ExtensionAPI['exec'] = async (command, arguments_, options) => {
      if (command === 'message-command') {
        const message = arguments_.at(-1)!;
        const replacement = join(dirname(message), 'replacement');
        await rename(message, replacement);
        await symlink(replacement, message);

        return { code: 0, killed: false, stdout: '', stderr: '' };
      }

      return runCommand(command, arguments_, options?.cwd ?? directory);
    };
    useCheckerExec(exec);
    const tool = createCommitTool({ exec });

    await expect(
      tool.execute(
        'symlink',
        { groups: [{ files: ['tau.json'], subject: 'feat: message' }] },
        undefined,
        undefined,
        commitContext(directory),
      ),
    ).rejects.toThrow(/Message check changed/);
  });

  it('rejects NUL in every group before any Git operation', async () => {
    const { exec, context } = fakeCommit();
    const tool = createCommitTool({ exec });
    for (const invalid of [
      { subject: 'feat: bad\0hidden' },
      { subject: 'feat: good', body: 'bad\0hidden' },
    ]) {
      await expect(
        tool.execute(
          'nul',
          {
            groups: [
              { files: ['one'], subject: 'feat: one' },
              { files: ['two'], ...invalid },
            ],
          },
          undefined,
          undefined,
          context as never,
        ),
      ).rejects.toThrow(/NUL/);
    }
    expect(exec).not.toHaveBeenCalled();
  });
});
