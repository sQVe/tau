import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commentPolicyHash, reviewGit } from './commentReview.js';
import type { CommentReview, reviewComments } from './commentReview.js';
import type { CommitInput } from './tool.js';
import {
  commitFailedError,
  createCommitTool as createReviewedCommitTool,
  validatePaths,
  validateSubject,
} from './tool.js';

// Git and approval tests use a clean reviewer.
// tests/commitFlow.integration.test.ts covers real Pi review.
const createCommitTool = (pi: Pick<ExtensionAPI, 'exec'>) =>
  createReviewedCommitTool(pi, async () => ({ findings: [] }));

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runCommand = async (
  command: string,
  commandArguments: string[],
  workingDirectory: string,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArguments, {
      cwd: workingDirectory,
    });

    return { stdout, stderr, code: 0, killed: false };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };

    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code ?? 1,
      killed: failure.killed ?? false,
    };
  }
};

const git = async (repositoryDirectory: string, commandArguments: string[]): Promise<string> => {
  const result = await runCommand('git', commandArguments, repositoryDirectory);

  if (result.code !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

const createTemporaryRepository = async (): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-'));
  temporaryDirectories.push(repositoryDirectory);

  await git(repositoryDirectory, ['init']);
  await git(repositoryDirectory, ['config', 'user.name', 'Tau Test']);
  await git(repositoryDirectory, ['config', 'user.email', 'tau@example.com']);
  await git(repositoryDirectory, ['config', 'commit.gpgsign', 'false']);

  return repositoryDirectory;
};

const writeRepositoryFile = async (
  repositoryDirectory: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const fullPath = join(repositoryDirectory, relativePath);

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
};

const getStoredCommitMessage = async (repositoryDirectory: string): Promise<string> => {
  const commitObject = await git(repositoryDirectory, ['cat-file', '-p', 'HEAD']);
  const separatorIndex = commitObject.indexOf('\n\n');

  if (separatorIndex === -1) {
    throw new Error('Could not locate commit message in git cat-file output');
  }

  return commitObject.slice(separatorIndex + 2);
};

const confirmedContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: true,
    ui: { custom: () => Promise.resolve('approve') },
  }) as never;

const declinedContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: true,
    ui: { custom: () => Promise.resolve('abort') },
  }) as never;

const noUiContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: false,
    ui: {},
  }) as never;

const executeCommit = async (repositoryDirectory: string, input: CommitInput) => {
  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  return commitTool.execute(
    'tool-call-1',
    input,
    undefined,
    undefined,
    confirmedContext(repositoryDirectory),
  );
};

const fakeCommit = (choices: (string | undefined)[], edits: (string | undefined)[] = []) => {
  const previews: string[] = [];
  const custom = vi.fn<
    (factory: Parameters<ExtensionContext['ui']['custom']>[0]) => Promise<string | undefined>
  >(async (factory) => {
    const component = await factory(
      { requestRender: () => {}, terminal: { rows: 60 } } as never,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      {} as never,
      () => {},
    );
    previews.push(component.render(80).join('\n'));

    return choices.shift();
  });

  const editor = vi.fn<ExtensionContext['ui']['editor']>(() => Promise.resolve(edits.shift()));

  const exec = vi.fn<ExtensionAPI['exec']>((_command, commandArguments) => {
    let stdout = '';

    if (commandArguments.includes('--numstat')) {
      stdout = '2\t1\tREADME.md\0-\t-\timage.png\0';
    }

    if (commandArguments[0] === 'rev-parse' || commandArguments[0] === 'write-tree') {
      stdout = 'abc123\n';
    }

    return Promise.resolve({ code: 0, killed: false, stderr: '', stdout });
  });
  const tool = createCommitTool({ exec });
  const context = { cwd: '/repo', hasUI: true, ui: { custom, editor } };
  const input = {
    groups: [
      {
        files: ['README.md'],
        subject: 'feat: add thing',
        body: 'Original body',
      },
    ],
  };

  const execute = (signal?: AbortSignal) =>
    tool.execute('call', input, signal, undefined, context as never);

  return { custom, editor, exec, context, input, execute, previews };
};

it('rejects calls outside Git before running configured commands or changing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-no-git-'));
  temporaryDirectories.push(directory);

  const config = JSON.stringify({
    prepare: ['sh', '-c', 'touch mutated'],
    check: ['sh', '-c', 'touch checked'],
  });

  await writeFile(join(directory, 'tau.json'), config);

  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? directory),
  );
  const tool = createCommitTool({ exec });

  await expect(
    tool.execute(
      'outside-git',
      {
        groups: [{ files: ['tau.json'], subject: 'chore: configure commands' }],
      },
      undefined,
      undefined,
      confirmedContext(directory),
    ),
  ).rejects.toThrow(/not a git repository/i);
  expect(exec.mock.calls.map(([command, arguments_]) => [command, arguments_])).toEqual([
    ['git', ['rev-parse', '--show-toplevel']],
  ]);
  expect(await readFile(join(directory, 'tau.json'), 'utf8')).toBe(config);
  await expect(readFile(join(directory, 'mutated'))).rejects.toThrow(/ENOENT/);
  await expect(readFile(join(directory, 'checked'))).rejects.toThrow(/ENOENT/);
});

it('prepares and checks without a package manifest', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'README.md', 'unformatted');
  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({
      prepare: [
        'sh',
        '-c',
        'test "$#" = 1 && test "$1" = "" && printf "formatted\\n" > README.md',
        'prepare',
        '',
      ],
      check: [
        'sh',
        '-c',
        'grep -qx formatted README.md && test "$#" = 1 && test "$1" = ""',
        'check',
        '',
      ],
    }),
  );

  const result = await executeCommit(repositoryDirectory, {
    groups: [{ files: ['README.md', 'tau.json'], subject: 'docs: format readme' }],
  });

  expect(JSON.stringify(result.content)).toContain('Project preparation passed: sh');
  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed: sh');
  expect(await git(repositoryDirectory, ['show', 'HEAD:README.md'])).toBe('formatted\n');
});

it.each([
  '{',
  'null',
  '[]',
  '{"prepare":null}',
  '{"prepare":[]}',
  '{"prepare":"make format"}',
  '{"prepare":[" "]}',
  '{"prepare":["make",1]}',
  '{"prepare":["make","\\u0000"]}',
  '{"check":null}',
  '{"check":[]}',
  '{"check":"make check"}',
  '{"check":[" "]}',
  '{"check":["make",1]}',
  '{"check":["make","\\u0000"]}',
])('rejects invalid command config before staging: %s', async (config) => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'tau.json', config);

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [{ files: ['tau.json'], subject: 'chore: configure commands' }],
    }),
  ).rejects.toThrow(/tau.json/);
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it.each([false, true])(
  'does not infer commands from package scripts with config present: %s',
  async (present) => {
    const repositoryDirectory = await createTemporaryRepository();

    if (present) {
      await writeRepositoryFile(repositoryDirectory, 'tau.json', '{}');
    }

    await writeRepositoryFile(
      repositoryDirectory,
      'package.json',
      JSON.stringify({
        packageManager: 'unsupported@1',
        scripts: { fix: 'exit 1', prepare: 'exit 1', check: 'exit 1' },
      }),
    );

    const result = await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: present ? ['tau.json', 'package.json'] : ['package.json'],
          subject: 'chore: configure project',
        },
      ],
    });

    expect(JSON.stringify(result.content)).toContain(
      present
        ? 'Project preparation unavailable: no prepare command in tau.json.'
        : 'Project preparation unavailable: no root tau.json.',
    );
    expect(result.details.groups[0]?.projectCheck).toBe(
      present
        ? 'Project check unavailable: no check command in tau.json.'
        : 'Project check unavailable: no root tau.json.',
    );
  },
);

it('rejects obsolete reserved and unknown settings before preparation or staging', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
  );
  const tool = createCommitTool({ exec });
  const settings = [
    { fix: ['make', 'format'] },
    { checkMessage: ['make', 'message'] },
    { hooks: 'skip' },
    { hooks: 'run' },
    { chek: ['make', 'check'] },
    { check: [] },
  ];
  const errors = [
    /fix.*rename.*prepare/i,
    /checkMessage.*not implemented/i,
    /hooks.*not implemented/i,
    /hooks.*not implemented/i,
    /unknown.*chek/i,
    /check.*nonempty/i,
  ];

  for (const [index, setting] of settings.entries()) {
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'touch mutated'],
        ...setting,
      }),
    );
    exec.mockClear();

    await expect(
      tool.execute(
        'invalid',
        {
          groups: [{ files: ['tau.json'], subject: 'chore: config' }],
        },
        undefined,
        undefined,
        confirmedContext(repositoryDirectory),
      ),
    ).rejects.toThrow(errors[index]);
    expect(
      exec.mock.calls.every(
        ([command, arguments_]) => command === 'git' && arguments_[0] === 'rev-parse',
      ),
    ).toBe(true);
    await expect(readFile(join(repositoryDirectory, 'mutated'))).rejects.toThrow(/ENOENT/);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  }
});

it('reports a failing preparation before staging or approval', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({
      prepare: ['sh', '-c', 'echo preparation failed >&2; exit 1'],
      check: ['sh', '-c', 'exit 0'],
    }),
  );
  const approval = vi.fn<ExtensionContext['ui']['custom']>();
  const tool = createCommitTool({
    exec: (command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
  });

  await expect(
    tool.execute(
      'fix',
      { groups: [{ files: ['tau.json'], subject: 'feat: fixture' }] },
      undefined,
      undefined,
      { cwd: repositoryDirectory, hasUI: true, ui: { custom: approval } } as never,
    ),
  ).rejects.toThrow(/Project preparation failed[\s\S]*preparation failed/);
  expect(approval).not.toHaveBeenCalled();
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it('reports missing preparation while still checking the candidate', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['sh', '-c', 'exit 0'] }),
  );

  const result = await executeCommit(repositoryDirectory, {
    groups: [{ files: ['tau.json'], subject: 'feat: fixture' }],
  });

  expect(JSON.stringify(result.content)).toContain(
    'Project preparation unavailable: no prepare command in tau.json.',
  );
  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
});

it('rejects an array as the root config before approval', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(repositoryDirectory, 'tau.json', '[]');

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [{ files: ['tau.json'], subject: 'feat: package' }],
    }),
  ).rejects.toThrow('tau.json must be an object');
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it('rejects a staged candidate whose project check fails despite an unstaged fix', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ prepare: ['sh', '-c', 'exit 0'], check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "if (require('./value.cjs') !== 2) throw Error('wrong value');",
  );
  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = 1;');
  await git(repositoryDirectory, ['add', '.']);
  await git(repositoryDirectory, ['commit', '-m', 'test: baseline']);

  const head = await git(repositoryDirectory, ['rev-parse', 'HEAD']);

  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = 2;');
  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', '-e', 'process.exit(0)'] }),
  );
  await writeRepositoryFile(repositoryDirectory, 'README.md', 'Document the change.');

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [{ files: ['README.md'], subject: 'docs: update' }],
    }),
  ).rejects.toThrow(/Project check failed.*|wrong value/s);
  expect(await git(repositoryDirectory, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
});

it('checks the first commit and leaves unrelated working changes untouched', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "require.resolve('typebox'); require('node:assert').equal(require('./value.cjs'), 2);",
  );
  await symlink(
    join(import.meta.dirname, '../../../node_modules'),
    join(repositoryDirectory, 'node_modules'),
    'dir',
  );
  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = 2;');
  await writeRepositoryFile(repositoryDirectory, 'unrelated.txt', 'Leave this alone.');

  const result = await executeCommit(repositoryDirectory, {
    groups: [
      {
        files: ['tau.json', 'check.cjs', 'value.cjs'],
        subject: 'feat: initial value',
      },
    ],
  });

  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
  expect(await readFile(join(repositoryDirectory, 'unrelated.txt'), 'utf8')).toBe(
    'Leave this alone.',
  );
  expect(await git(repositoryDirectory, ['ls-tree', '--name-only', 'HEAD'])).not.toContain(
    'unrelated.txt',
  );
}, 30_000);

it('checks a staged tree that tracks node_modules', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "require('./node_modules/vendored.cjs');",
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'node_modules/vendored.cjs',
    'module.exports = 1;',
  );

  const result = await executeCommit(repositoryDirectory, {
    groups: [
      {
        files: ['tau.json', 'check.cjs', 'node_modules/vendored.cjs'],
        subject: 'feat: vendored dependency',
      },
    ],
  });

  expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
}, 30_000);

it('returns cancelled when aborted while the project check runs', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const controller = new AbortController();

  await git(repositoryDirectory, ['commit', '--allow-empty', '-m', 'test: baseline']);

  const head = await git(repositoryDirectory, ['rev-parse', 'HEAD']);

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(repositoryDirectory, 'check.cjs', '');

  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      if (command === 'node' && commandArguments.includes('check.cjs')) {
        controller.abort();
      }

      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  const result = await commitTool.execute(
    'tool-call-1',
    { groups: [{ files: ['tau.json', 'check.cjs'], subject: 'feat: check' }] },
    controller.signal,
    undefined,
    confirmedContext(repositoryDirectory),
  );

  const currentHead = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const stagedFiles = await git(repositoryDirectory, ['diff', '--cached', '--name-only']);

  expect(result.content).toEqual([
    { type: 'text', text: 'no test runner resolves from this worktree' },
    { type: 'text', text: 'Commit cancelled' },
  ]);
  expect(currentHead).toBe(head);
  expect(stagedFiles).toBe('');
});

it('returns cancelled when aborted while project preparation runs', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const controller = new AbortController();

  await git(repositoryDirectory, ['commit', '--allow-empty', '-m', 'test: baseline']);

  const head = await git(repositoryDirectory, ['rev-parse', 'HEAD']);

  await writeRepositoryFile(repositoryDirectory, 'check.cjs', '');
  await writeRepositoryFile(repositoryDirectory, 'prepare.cjs', '');
  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ prepare: ['node', 'prepare.cjs'], check: ['node', 'check.cjs'] }),
  );

  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      if (command === 'node' && commandArguments.includes('prepare.cjs')) {
        controller.abort();
      }

      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  const result = await commitTool.execute(
    'tool-call-1',
    {
      groups: [
        { files: ['tau.json', 'check.cjs', 'prepare.cjs'], subject: 'feat: prepare and check' },
      ],
    },
    controller.signal,
    undefined,
    confirmedContext(repositoryDirectory),
  );

  const currentHead = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const stagedFiles = await git(repositoryDirectory, ['diff', '--cached', '--name-only']);

  expect(result.content).toEqual([
    { type: 'text', text: 'no test runner resolves from this worktree' },
    { type: 'text', text: 'Commit cancelled' },
  ]);
  expect(currentHead).toBe(head);
  expect(stagedFiles).toBe('');
});

it.each(['pass', 'fail', 'killed', 'cancel'] as const)(
  'cleans up the candidate after check result: %s',
  async (outcome) => {
    const repositoryDirectory = await createTemporaryRepository();
    const controller = new AbortController();
    let candidateDirectory = '';

    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({ check: ['check-command', ''] }),
    );

    const tool = createCommitTool({
      exec: (command, arguments_, options) => {
        if (command !== 'check-command') {
          return runCommand(command, arguments_, options?.cwd ?? repositoryDirectory);
        }

        candidateDirectory = options?.cwd ?? '';
        expect(candidateDirectory).not.toBe(repositoryDirectory);
        expect(arguments_).toEqual(['']);
        expect(options).toMatchObject({ signal: controller.signal, timeout: 600_000 });

        if (outcome === 'cancel') {
          controller.abort();
        }

        return Promise.resolve({
          code: outcome === 'fail' ? 1 : 0,
          killed: outcome === 'killed',
          stdout: '',
          stderr: 'check diagnostic',
        });
      },
    });
    const result = tool.execute(
      'cleanup',
      {
        groups: [{ files: ['tau.json'], subject: 'chore: configure check' }],
      },
      controller.signal,
      undefined,
      confirmedContext(repositoryDirectory),
    );

    const message = await result.then(
      (committed) => JSON.stringify(committed.content),
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const expected = {
      pass: /Project check passed/,
      fail: /Project check failed.*check diagnostic/s,
      killed: /Project check failed.*check diagnostic/s,
      cancel: /Commit cancelled/,
    };

    expect(message).toMatch(expected[outcome]);

    expect(candidateDirectory).not.toBe('');
    await expect(readFile(join(candidateDirectory, 'tau.json'))).rejects.toThrow(/ENOENT/);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  },
);

it('rejects check-time formatting without modifying the working file', async () => {
  const repositoryDirectory = await createTemporaryRepository();

  await writeRepositoryFile(
    repositoryDirectory,
    'tau.json',
    JSON.stringify({ check: ['node', 'check.cjs'] }),
  );
  await writeRepositoryFile(
    repositoryDirectory,
    'check.cjs',
    "require('node:fs').writeFileSync('value.cjs', 'module.exports = 2;');",
  );
  await writeRepositoryFile(repositoryDirectory, 'value.cjs', 'module.exports = (2);');

  await expect(
    executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['tau.json', 'check.cjs', 'value.cjs'],
          subject: 'feat: initial value',
        },
      ],
    }),
  ).rejects.toThrow('Project check changed tracked files');
  expect(await readFile(join(repositoryDirectory, 'value.cjs'), 'utf8')).toBe(
    'module.exports = (2);',
  );
});

describe('reviewGit', () => {
  it('identifies the failing command after global Git options', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await expect(
      reviewGit(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        repositoryDirectory,
        ['--literal-pathspecs', 'ls-tree', 'missing-tree'],
      ),
    ).rejects.toThrow('git --literal-pathspecs ls-tree missing-tree failed');
  });
});

describe('validateSubject', () => {
  it('throws a validation error naming the subject when it is not a conventional commit', () => {
    const subject = 'Add stuff.';

    expect(() => {
      validateSubject(subject);
    }).toThrow(new RegExp(`subject.*${subject.replace('.', '\\.')}`, 'i'));
  });

  it('returns without throwing when the subject is a conventional commit', () => {
    expect(() => {
      validateSubject('feat: add thing');
    }).not.toThrow();
    expect(() => {
      validateSubject('fix(scope): do it');
    }).not.toThrow();
    expect(() => {
      validateSubject('chore!: breaking');
    }).not.toThrow();
  });
});

describe('validatePaths', () => {
  it('throws an error naming the offending path when any file matches the sensitive denylist', () => {
    expect(() => {
      validatePaths(['.env']);
    }).toThrow(/\.env/);
    expect(() => {
      validatePaths(['db/credentials.json']);
    }).toThrow(/db\/credentials\.json/);
    expect(() => {
      validatePaths(['keys/id_rsa']);
    }).toThrow(/keys\/id_rsa/);
    expect(() => {
      validatePaths(['.ssh/config']);
    }).toThrow(/\.ssh\/config/);
  });

  it('rejects paths with leading dot-slash that would bypass anchored patterns', () => {
    expect(() => {
      validatePaths(['./.env']);
    }).toThrow(/\.env/);
  });

  it('rejects sensitive paths that redundant separators would otherwise hide', () => {
    expect(() => {
      validatePaths(['.//id_rsa']);
    }).toThrow(/id_rsa/);
    expect(() => {
      validatePaths(['./././id_rsa']);
    }).toThrow(/id_rsa/);
  });

  it('rejects sensitive files in subdirectories', () => {
    expect(() => {
      validatePaths(['config/.env']);
    }).toThrow(/config\/\.env/);
    expect(() => {
      validatePaths(['packages/app/.npmrc']);
    }).toThrow(/\.npmrc/);
    expect(() => {
      validatePaths(['home/.ssh/config']);
    }).toThrow(/\.ssh/);
  });

  it('rejects sensitive paths whose casing differs from the pattern', () => {
    expect(() => {
      validatePaths(['.ENV']);
    }).toThrow(/\.ENV/);
    expect(() => {
      validatePaths(['.Env.production']);
    }).toThrow(/\.Env\.production/);
  });

  it('rejects paths that resolve to the repository root', () => {
    for (const pathspec of ['./', '.', './.', 'src/..']) {
      expect(() => {
        validatePaths([pathspec]);
      }).toThrow(/Invalid path/);
    }
  });

  it('rejects an .ssh directory named without a trailing slash', () => {
    expect(() => {
      validatePaths(['.ssh']);
    }).toThrow(/\.ssh/);
    expect(() => {
      validatePaths(['home/.ssh']);
    }).toThrow(/\.ssh/);
  });

  it('accepts filenames containing glob characters, which git takes literally', () => {
    expect(() => {
      validatePaths(['app/[slug]/page.tsx', 'docs/faq?.md']);
    }).not.toThrow();
  });

  it('rejects pathspec magic and traversal attempts', () => {
    expect(() => {
      validatePaths([':(glob)*.ts']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['../etc/passwd']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['/etc/passwd']);
    }).toThrow(/Invalid path/);
  });

  it('rejects traversal that only escapes the repository once collapsed', () => {
    expect(() => {
      validatePaths(['src/../../etc/passwd']);
    }).toThrow(/Invalid path/);
    expect(() => {
      validatePaths(['src/..']);
    }).toThrow(/Invalid path/);
  });

  it('returns without throwing when all files are outside the sensitive denylist', () => {
    expect(() => {
      validatePaths(['src/foo.ts', 'README.md', 'docs/env.md']);
    }).not.toThrow();
  });
});

describe('commitTool.execute', () => {
  const createPrefetchRepository = async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
    await git(repositoryDirectory, ['add', 'base.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: base']);

    const groups = ['one', 'two', 'three'].map((name) => ({
      files: [`${name}.txt`],
      subject: `feat: add ${name}`,
    }));

    for (const group of groups) {
      await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
    }

    return { repositoryDirectory, groups };
  };

  it('returns findings for corrections before requiring a waiver under approve-all', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const groups = ['one', 'two', 'three'].map((name) => ({
      files: [`${name}.txt`],
      subject: `feat: add ${name}`,
    }));

    for (const group of groups) {
      await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
    }

    const review = vi
      .fn<typeof reviewComments>()
      .mockResolvedValueOnce({ findings: [] })
      .mockResolvedValue({
        findings: [{ path: 'two.txt', line: 1, kind: 'policy', message: 'Remove stale note.' }],
      });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );
    const { context, custom } = fakeCommit(['approveAll', 'approveAll']);
    context.cwd = repositoryDirectory;

    await expect(
      tool.execute('batch', { groups }, undefined, undefined, context as never),
    ).rejects.toThrow(
      /Comment review needs corrections \(1\/2 automatic returns\):\n.*Remove stale note\./s,
    );

    expect(custom).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);

    const retry = () =>
      tool.execute('retry', { groups: groups.slice(1) }, undefined, undefined, context as never);

    await expect(retry()).rejects.toThrow(
      /Comment review needs corrections \(2\/2 automatic returns\):\n.*Remove stale note\./s,
    );

    expect(custom).toHaveBeenCalledTimes(1);
    await expect(retry()).rejects.toThrow(
      /Comment review requires an explicit user waiver\.\n.*Remove stale note\./s,
    );

    expect(custom).toHaveBeenCalledTimes(2);
    expect((await git(repositoryDirectory, ['log', '--format=%s'])).trim()).toBe(
      groups[0]!.subject,
    );
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('reviews the next group while the current overlay is open', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const reviewsWhenOverlayOpened: number[] = [];
    const context = {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: {
        custom: () => {
          reviewsWhenOverlayOpened.push(review.mock.calls.length);

          return Promise.resolve('approve');
        },
      },
    };
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(reviewsWhenOverlayOpened).toEqual([2, 3, 3]);
    expect(review).toHaveBeenCalledTimes(3);
    expect(
      (await git(repositoryDirectory, ['log', '--format=%s', '-3'])).trim().split('\n'),
    ).toEqual(['feat: add three', 'feat: add two', 'feat: add one']);
  });

  it('re-reviews a group whose prefetch assumed an earlier group would commit', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const reviewed: string[][] = [];

    const review = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
      reviewed.push(
        (await git(repositoryDirectory, ['ls-tree', '--name-only', snapshot.tree]))
          .trim()
          .split('\n'),
      );

      return { findings: [] };
    });
    const choices = ['approve', 'skip', 'approve'];
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom: () => Promise.resolve(choices.shift()) },
    } as never);

    // Skipping two.txt invalidates the third group's planned tree, so it needs another review.
    expect(reviewed).toEqual([
      ['base.txt', 'one.txt'],
      ['base.txt', 'one.txt', 'two.txt'],
      ['base.txt', 'one.txt', 'three.txt', 'two.txt'],
      ['base.txt', 'one.txt', 'three.txt'],
    ]);

    expect(
      (await git(repositoryDirectory, ['log', '--format=%s', '-2'])).trim().split('\n'),
    ).toEqual(['feat: add three', 'feat: add one']);
  });

  it('reopens the overlay for a group whose files changed after approve all', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const choices = ['approveAll'];

    const custom = vi.fn<() => Promise<string | undefined>>(() =>
      Promise.resolve(choices.shift() ?? 'approve'),
    );
    const tool = createReviewedCommitTool(
      {
        exec: async (command, commandArguments, options) => {
          const result = await runCommand(
            command,
            commandArguments,
            options?.cwd ?? repositoryDirectory,
          );

          // Simulate a group-1 hook that edits a later group's file without staging it.
          if (commandArguments[0] === 'commit') {
            await writeRepositoryFile(repositoryDirectory, 'three.txt', 'rewritten by a hook');
          }

          return result;
        },
      },
      async () => ({ findings: [] }),
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom },
    } as never);

    // Group 3 changed after approve-all, so it needs another overlay.
    expect(custom).toHaveBeenCalledTimes(2);
    expect(await git(repositoryDirectory, ['show', 'HEAD:three.txt'])).toBe('rewritten by a hook');
    expect((await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  });

  it('reviews every remaining group as soon as approve all is chosen', async () => {
    const { repositoryDirectory, groups } = await createPrefetchRepository();
    const events: string[] = [];

    const review = vi.fn<typeof reviewComments>(() => {
      events.push('review');

      return Promise.resolve({ findings: [] });
    });

    const custom = vi.fn<() => Promise<string>>(() => Promise.resolve('approveAll'));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) => {
          if (commandArguments[0] === 'commit') {
            events.push('commit');
          }

          return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
        },
      },
      review,
    );

    await tool.execute('batch', { groups }, undefined, undefined, {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: { custom },
    } as never);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['review', 'review', 'review', 'commit', 'commit', 'commit']);
    expect((await git(repositoryDirectory, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  });

  it.each(['approve', 'skip', 'approveAll'])(
    'processes three groups sequentially using %s',
    async (middle) => {
      const repositoryDirectory = await createTemporaryRepository();

      const groups = ['one', 'two', 'three'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));

      for (const group of groups) {
        await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
      }

      const heads: (string | null)[] = [];
      const trees: string[][] = [];

      const review: typeof reviewComments = async (_pi, _context, _signal, snapshot) => {
        heads.push(snapshot.head);
        trees.push(
          (await git(repositoryDirectory, ['ls-tree', '--name-only', snapshot.tree]))
            .trim()
            .split('\n'),
        );

        return { findings: [] };
      };
      const tool = createReviewedCommitTool(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        review,
      );
      const { context, custom, previews } = fakeCommit(
        middle === 'approveAll' ? ['approveAll'] : ['approve', middle, 'approve'],
      );
      context.cwd = repositoryDirectory;
      const result = await tool.execute(
        'batch',
        { groups },
        undefined,
        undefined,
        context as never,
      );
      const commitHashes = (await git(repositoryDirectory, ['log', '--reverse', '--format=%H']))
        .trim()
        .split('\n');

      expect(commitHashes).toHaveLength(middle === 'skip' ? 2 : 3);
      expect(
        (await git(repositoryDirectory, ['log', '--reverse', '--format=%s'])).trim().split('\n'),
      ).toEqual(
        groups.filter((_, index) => middle !== 'skip' || index !== 1).map((group) => group.subject),
      );

      expect(result.details.groups.map((group) => group.sha).filter(Boolean)).toEqual(commitHashes);

      for (const commitHash of commitHashes) {
        expect(JSON.stringify(result.content)).toContain(commitHash);
      }

      expect(result.details.groups[1]?.skipped).toBe(middle === 'skip' ? true : undefined);
      expect(JSON.stringify(result.content).includes('Group 2/3: Commit skipped')).toBe(
        middle === 'skip',
      );

      expect(heads).toEqual([
        null,
        commitHashes[0],
        middle === 'skip' ? commitHashes[0] : commitHashes[1],
      ]);
      expect(trees).toEqual([
        ['one.txt'],
        ['one.txt', 'two.txt'],
        middle === 'skip' ? ['one.txt', 'three.txt'] : ['one.txt', 'three.txt', 'two.txt'],
      ]);

      expect(custom).toHaveBeenCalledTimes(middle === 'approveAll' ? 1 : 3);
      expect(previews.map((preview, index) => preview.includes(`commit ${index + 1}/3`))).toEqual(
        middle === 'approveAll' ? [true] : [true, true, true],
      );

      expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
    },
  );

  it.each([
    { files: ['two.txt'], subject: 'invalid' },
    { files: ['.env'], subject: 'feat: add two' },
  ])('validates all groups before staging: %j', async (invalid) => {
    const { input, execute, exec } = fakeCommit(['approve', 'approve']);
    input.groups.push({ ...invalid, body: '' });

    await expect(execute()).rejects.toThrow(/Invalid/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['abort', 'cancel', 'corrections', 'retry', 'hook'])(
    'stops on %s and names earlier commits',
    async (failure) => {
      const repositoryDirectory = await createTemporaryRepository();

      const groups = ['one', 'two', 'three', 'four'].map((name) => ({
        files: [`${name}.txt`],
        subject: `feat: add ${name}`,
      }));

      for (const group of groups) {
        await writeRepositoryFile(repositoryDirectory, group.files[0]!, group.subject);
      }

      const controller = new AbortController();
      let reviews = 0;

      const review = async () => {
        reviews += 1;

        if (reviews === 3 && failure === 'corrections') {
          return {
            findings: [
              { path: 'three.txt', line: 1, kind: 'policy' as const, message: 'Fix comment.' },
            ],
          };
        }

        if (reviews === 3 && failure === 'retry') {
          throw new Error('Reviewer unavailable');
        }

        return { findings: [] };
      };
      let overlays = 0;
      const context = {
        cwd: repositoryDirectory,
        hasUI: true,
        ui: {
          custom: async () => {
            overlays += 1;

            if (overlays <= 2) {
              return 'approve';
            }

            if (failure === 'cancel') {
              controller.abort();
            }

            if (failure === 'hook') {
              await writeRepositoryFile(
                repositoryDirectory,
                '.git/hooks/pre-commit',
                '#!/bin/sh\necho hook said no >&2\nexit 1\n',
              );
              await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

              return 'approve';
            }

            return failure === 'retry' ? 'retry' : 'abort';
          },
        },
      };
      const tool = createReviewedCommitTool(
        {
          exec: (command, commandArguments, options) =>
            runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
        },
        review,
      );
      const failureError = await tool
        .execute('batch', { groups }, controller.signal, undefined, context as never)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const commitHashes = (await git(repositoryDirectory, ['log', '--reverse', '--format=%H']))
        .trim()
        .split('\n');

      expect(failureError).toBeInstanceOf(Error);
      expect(commitHashes).toHaveLength(2);

      for (const [index, commitHash] of commitHashes.entries()) {
        expect((failureError as Error).message).toContain(`Group ${index + 1}/4: ${commitHash}`);
      }

      expect((failureError as Error).message).toContain('Group 3/4');
      expect((failureError as Error).message).toContain(
        {
          abort: 'declined',
          cancel: 'cancelled',
          corrections: '1/2 automatic returns',
          retry: 'User requested fixes',
          hook: 'hook said no',
        }[failure]!,
      );

      expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
      expect(reviews).toBe(3);
      expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

      if (failure === 'hook') {
        await rm(join(repositoryDirectory, '.git/hooks/pre-commit'));
      }

      const result = await tool.execute(
        'retry',
        { groups: groups.slice(3) },
        undefined,
        undefined,
        confirmedContext(repositoryDirectory),
      );

      expect(result.details.groups[0]!.sha).not.toBe('');
      expect(
        (await git(repositoryDirectory, ['show', '--name-only', '--format=', 'HEAD'])).trim(),
      ).toBe('four.txt');

      expect(await git(repositoryDirectory, ['status', '--short'])).toBe('?? three.txt\n');
    },
  );

  it('undoes a commit when a hook changes reviewed content in an approved file', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const hookPath = join(repositoryDirectory, '.git/hooks/pre-commit');

    await writeFile(
      hookPath,
      '#!/bin/sh\nprintf "// Unreviewed comment\\n" >> retry.ts\ngit add retry.ts\n',
    );
    await chmod(hookPath, 0o755);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }],
      }),
    ).rejects.toThrow(/changed reviewed content/);
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('rejects staged content changed while commit approval is open', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'retry.ts', 'export const retries = 0;\n');

    const tool = createCommitTool({
      exec: (command, commandArguments, options) =>
        runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
    });
    const context = {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: {
        custom: async () => {
          await writeRepositoryFile(
            repositoryDirectory,
            'retry.ts',
            '// Unreviewed comment\nexport const retries = 1;\n',
          );
          await git(repositoryDirectory, ['add', 'retry.ts']);

          return 'approve';
        },
      },
    } as never;

    await expect(
      tool.execute(
        'changed',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(/changed since comment review/);
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('expires old abandoned review groups', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [{ path: 'retry.ts', line: 1, kind: 'policy' as const, message: 'Stale comment.' }],
    }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );

    const call = (path: string) =>
      tool.execute(
        'test',
        { groups: [{ files: [path], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        confirmedContext(repositoryDirectory),
      );
    for (let index = 0; index < 33; index += 1) {
      const path = `retry${index}.ts`;

      await writeRepositoryFile(repositoryDirectory, path, '// stale\n');

      await expect(call(path)).rejects.toThrow('1/2 automatic returns');
    }

    await expect(call('retry0.ts')).rejects.toThrow('1/2 automatic returns');
    expect(review).toHaveBeenCalledTimes(34);
  }, 30_000);

  it.each(['skip', 'abort', 'cancel'])('resets correction attempts after %s', async (choice) => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(
      repositoryDirectory,
      'retry.ts',
      '// stale\nexport const retries = 0;\n',
    );

    const review = vi.fn<() => Promise<CommentReview>>(async () => ({
      findings: [
        { path: 'retry.ts', line: 1, kind: 'inaccurate' as const, message: 'Stale comment.' },
      ],
    }));
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
    );
    const controller = new AbortController();
    const context = {
      cwd: repositoryDirectory,
      hasUI: true,
      ui: {
        custom: async () => {
          if (choice === 'cancel') {
            controller.abort();
          }

          return choice;
        },
      },
    } as unknown as ExtensionContext;

    const call = () =>
      tool.execute(
        'test',
        { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
        undefined,
        undefined,
        context,
      );

    await expect(call()).rejects.toThrow('1/2 automatic returns');
    await expect(call()).rejects.toThrow('2/2 automatic returns');

    const finish = tool.execute(
      'test',
      { groups: [{ files: ['retry.ts'], subject: 'feat: add retry' }] },
      controller.signal,
      undefined,
      context,
    );
    const outcome = await finish.then(
      () => 'returned',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(outcome).toBe(choice === 'abort' ? 'Commit declined by user' : 'returned');
    await expect(call()).rejects.toThrow('1/2 automatic returns');
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('throws and unstages when the user aborts the overlay', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    await expect(
      commitTool.execute(
        'tool-call-1',
        { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
        undefined,
        undefined,
        declinedContext(repositoryDirectory),
      ),
    ).rejects.toThrow(/declined/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('throws in non-interactive mode without attempting to commit', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    await expect(
      commitTool.execute(
        'tool-call-1',
        { groups: [{ files: ['README.md'], subject: 'feat: add thing' }] },
        undefined,
        undefined,
        noUiContext(repositoryDirectory),
      ),
    ).rejects.toThrow(/non-interactive/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('creates one commit and returns the HEAD hash in details', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    const result = await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add thing',
          body: 'Initial project file.',
        },
      ],
    });

    const commitHashOutput = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
    const logOutput = await git(repositoryDirectory, ['log', '--oneline']);
    const latestSubjectOutput = await git(repositoryDirectory, ['log', '-1', '--format=%s']);

    const commitHash = commitHashOutput.trim();
    const logLines = logOutput.trim().split('\n');
    const latestSubject = latestSubjectOutput.trim();

    expect(logLines).toHaveLength(1);
    expect(latestSubject).toBe('feat: add thing');
    expect(result.details.groups[0]).toEqual({
      sha: commitHash,
      files: ['README.md'],
      subject: 'feat: add thing',
      body: 'Initial project file.',
      projectCheck: 'Project check unavailable: no root tau.json.',
      commentReview: {
        status: 'passed',
        tree: (await git(repositoryDirectory, ['rev-parse', 'HEAD^{tree}'])).trim(),
        policy: commentPolicyHash,
        report: '',
      },
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'no test runner resolves from this worktree' },
      {
        type: 'text',
        text: `${commitHash} feat: add thing\nProject preparation unavailable: no root tau.json.\nProject check unavailable: no root tau.json.`,
      },
    ]);
  });

  it('includes the body in the committed message when body is provided', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');

    await executeCommit(repositoryDirectory, {
      groups: [
        {
          files: ['README.md'],
          subject: 'feat: add',
          body: 'Longer explanation here.',
        },
      ],
    });

    const body = await getStoredCommitMessage(repositoryDirectory);

    expect(body).toBe('feat: add\n\nLonger explanation here.\n');
  });

  it('refuses to commit when unrelated paths are already staged', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'notes.md', 'keep staged\n');
    await git(repositoryDirectory, ['add', '--', 'notes.md']);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: notes\.md/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit a glob, because git matches the pattern literally', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['*'],
            subject: 'feat: add everything',
          },
        ],
      }),
    ).rejects.toThrow(/git add failed/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('commits when the working directory is a subdirectory of the repository', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'sub/a.txt', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      'sub/tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'exit 81'],
        check: ['sh', '-c', 'exit 82'],
      }),
    );
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'printf "prepared\\n" > sub/a.txt'],
        check: ['grep', '-qx', 'prepared', 'sub/a.txt'],
      }),
    );
    await git(repositoryDirectory, ['add', 'tau.json', 'sub/tau.json']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: configure commands']);

    const commitTool = createCommitTool({
      exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
        return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
      },
    });

    const result = await commitTool.execute(
      'tool-call-1',
      { groups: [{ files: ['a.txt'], subject: 'feat: add a' }] },
      undefined,
      undefined,
      confirmedContext(join(repositoryDirectory, 'sub')),
    );

    expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
    expect(await git(repositoryDirectory, ['show', 'HEAD:sub/a.txt'])).toBe('prepared\n');
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('2');
    expect(
      (await git(repositoryDirectory, ['show', '--name-only', '--format=', 'HEAD'])).trim(),
    ).toBe('sub/a.txt');
  });

  it('restores the index when staging pulls in files alongside a requested one', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');
    await writeRepositoryFile(repositoryDirectory, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['src/a.ts', 'src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/staged paths that were not requested/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('refuses to commit when staging a named path pulls in files it did not name', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'src/a.ts', 'export const a = 1;\n');
    await writeRepositoryFile(repositoryDirectory, 'src/b.ts', 'export const b = 2;\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['src'],
            subject: 'feat: add sources',
          },
        ],
      }),
    ).rejects.toThrow(/staged paths that were not requested/i);

    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  });

  it('refuses to commit when an unrelated staged type change exists', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'link.txt', 'plain\n');
    await git(repositoryDirectory, ['add', '--', 'README.md', 'link.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'initial']);

    await rm(join(repositoryDirectory, 'link.txt'));
    await symlink('/etc/hostname', join(repositoryDirectory, 'link.txt'));
    await git(repositoryDirectory, ['add', '--', 'link.txt']);

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: link\.txt/i);
  });

  it('refuses to commit when an unrelated staged deletion exists', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'old.md', 'gone\n');
    await git(repositoryDirectory, ['add', '--', 'README.md', 'old.md']);
    await git(repositoryDirectory, ['commit', '-m', 'initial']);
    await git(repositoryDirectory, ['rm', '--', 'old.md']);

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'updated\n');

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: update readme',
          },
        ],
      }),
    ).rejects.toThrow(/already staged: old\.md/i);
  });

  it('prepares once before staging and approves the prepared bytes on the first call', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await git(repositoryDirectory, ['commit', '--allow-empty', '-m', 'test: baseline']);
    await writeRepositoryFile(repositoryDirectory, 'second.txt', 'second group');
    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngrep -qx formatted README.md || exit 1\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    await writeRepositoryFile(
      repositoryDirectory,
      'prepare.cjs',
      "require('node:assert').equal(require('node:child_process').execSync('git diff --cached --name-only').toString(), ''); require('node:fs').writeFileSync('README.md', 'formatted\\n'); require('node:fs').writeFileSync('unrelated.txt', 'also fixed');",
    );
    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({
        prepare: ['node', 'prepare.cjs'],
        check: ['grep', '-qx', 'formatted', 'README.md'],
      }),
    );
    const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
    );
    const tool = createReviewedCommitTool({ exec }, async (_pi, _context, _signal, snapshot) => {
      expect(await git(repositoryDirectory, ['show', `${snapshot?.tree}:README.md`])).toBe(
        'formatted\n',
      );

      return { findings: [] };
    });
    const result = await tool.execute(
      'fix',
      {
        groups: [
          {
            files: ['README.md', 'prepare.cjs', 'tau.json'],
            subject: 'feat: add readme',
          },
          { files: ['second.txt'], subject: 'feat: second group' },
        ],
      },
      undefined,
      undefined,
      confirmedContext(repositoryDirectory),
    );

    expect(JSON.stringify(result.content)).toContain(
      'Project preparation passed: node prepare.cjs',
    );
    expect(result.details.groups[0]?.projectCheck).toContain('Project check passed');
    expect(exec.mock.calls.filter(([command]) => command === 'node')).toHaveLength(1);
    expect(exec.mock.calls.filter(([command]) => command === 'grep')).toHaveLength(2);

    const statusOutput = await git(repositoryDirectory, ['status', '--short']);
    const committedContent = await git(repositoryDirectory, ['show', 'HEAD:README.md']);

    expect(await git(repositoryDirectory, ['rev-list', '--all', '--count'])).toBe('3\n');
    expect(statusOutput).toBe('?? unrelated.txt\n');
    expect(committedContent).toBe('formatted\n');
  });

  it('undoes the commit when a hook stages unrequested paths', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'sneaky.txt', 'not requested\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- sneaky.txt\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/hook staged paths that were not requested: sneaky\.txt/i);

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('README.md\n');
  });

  it('undoes only the new commit when a hook stages an unrequested path', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'base.txt', 'base\n');
    await git(repositoryDirectory, ['add', '--', 'base.txt']);
    await git(repositoryDirectory, ['commit', '-m', 'chore: base']);

    const baseCommitHash = (await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(repositoryDirectory, 'sneaky.txt', 'not requested\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- sneaky.txt\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add readme',
          },
        ],
      }),
    ).rejects.toThrow(/hook staged paths that were not requested/i);

    expect((await git(repositoryDirectory, ['rev-parse', 'HEAD'])).trim()).toBe(baseCommitHash);
  });

  it('reports hook failure details and leaves no commits when git commit fails', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await writeRepositoryFile(repositoryDirectory, 'README.md', 'hello\n');
    await writeRepositoryFile(
      repositoryDirectory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho hook output\necho hook said no >&2\nexit 1\n',
    );
    await chmod(join(repositoryDirectory, '.git/hooks/pre-commit'), 0o755);

    let thrown: unknown;

    try {
      await executeCommit(repositoryDirectory, {
        groups: [
          {
            files: ['README.md'],
            subject: 'feat: add',
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('git commit failed:');
    expect((thrown as Error).message).toContain('hook said no');

    const revListResult = await runCommand(
      'git',
      ['rev-list', '--all', '--count'],
      repositoryDirectory,
    );

    expect(revListResult.stdout.trim()).toBe('0');
  }, 10_000);

  it('falls back to stdout in the error message when stderr is only whitespace', () => {
    expect(commitFailedError('hook output\n', '   \n').message).toBe(
      'git commit failed: hook output',
    );
  });

  it('keeps both streams in the error message when a hook writes to each', () => {
    const message = commitFailedError('lint failed on src/a.ts\n', 'warning: slow hook\n').message;

    expect(message).toContain('lint failed on src/a.ts');
    expect(message).toContain('warning: slow hook');
  });
});

describe('preapproved commits', () => {
  it('reviews and commits every group without opening the overlay', async () => {
    const { exec, context, custom } = fakeCommit(['abort']);
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool({ exec }, review, () => true);
    const groups = [
      { files: ['one.txt'], subject: 'feat: add one' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];

    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(result.details.groups.map((group) => group.subject)).toEqual(
      groups.map((group) => group.subject),
    );
    expect(review).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.filter((call) => call[1][0] === 'commit')).toHaveLength(2);
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns review failures and never opens a waiver dialog', async () => {
    const { exec, context, custom, input } = fakeCommit(['waive']);
    const review = vi
      .fn<typeof reviewComments>()
      .mockRejectedValue(new Error('Reviewer unavailable'));
    const tool = createReviewedCommitTool({ exec }, review, () => true);

    await expect(
      tool.execute('call', input, undefined, undefined, context as never),
    ).rejects.toThrow(/requires an explicit user waiver.*Reviewer unavailable/s);

    expect(custom).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('returns a blocker after two correction attempts without waiving findings', async () => {
    const { exec, context, custom, input } = fakeCommit(['waive']);
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({
      findings: [{ path: 'README.md', line: 1, kind: 'inaccurate', message: 'Incorrect claim.' }],
    });
    const tool = createReviewedCommitTool({ exec }, review, () => true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        tool.execute('call', input, undefined, undefined, context as never),
      ).rejects.toThrow(
        attempt <= 2 ? `needs corrections (${attempt}/2` : 'requires an explicit user waiver',
      );
    }

    expect(custom).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it('still rejects failed project checks without a UI', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool(
      {
        exec: (command, commandArguments, options) =>
          runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory),
      },
      review,
      () => true,
    );

    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({ check: ['node', '-e', 'process.exit(1)'] }),
    );

    await expect(
      tool.execute(
        'call',
        {
          groups: [{ files: ['tau.json'], subject: 'feat: add package' }],
        },
        undefined,
        undefined,
        noUiContext(repositoryDirectory),
      ),
    ).rejects.toThrow('Project check failed');

    expect(review).not.toHaveBeenCalled();
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
    expect((await git(repositoryDirectory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });
});

describe('commit overlay flow', () => {
  it('applies a dispute only to the group carrying it', async () => {
    const { exec, context } = fakeCommit(['approve', 'approve']);
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const tool = createReviewedCommitTool({ exec }, review);
    const groups = [
      { files: ['one.txt'], subject: 'feat: add one', commentDispute: 'Explains a constraint.' },
      { files: ['two.txt'], subject: 'feat: add two' },
    ];
    const result = await tool.execute('batch', { groups }, undefined, undefined, context as never);

    expect(review.mock.calls.map((call) => call[3].dispute)).toEqual([
      'Explains a constraint.',
      undefined,
    ]);

    expect(result.details.groups[0]!.commentReview!.report).toContain('rechecked after dispute');
    expect(result.details.groups[1]!.commentReview!.report).not.toContain(
      'rechecked after dispute',
    );

    expect(result.details.groups[1]!.commentReview!.report).not.toContain(
      'No prior findings available.',
    );
  });

  it('stages and reads numstat before showing the overlay', async () => {
    const { execute, exec, custom, previews } = fakeCommit(['approve']);

    await execute();

    expect(previews[0]).toMatch(/\n commit *\n/);
    expect(previews[0]).not.toContain('1/1');
    expect(previews[0]).toContain('README.md +2 -1');
    expect(previews[0]).toContain('image.png binary');
    expect(exec.mock.calls.slice(0, 5).map((call) => call[1])).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--show-prefix'],
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
      ['--literal-pathspecs', 'add', '--', 'README.md'],
      ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
    ]);

    const numstatCall = exec.mock.calls.findIndex((call) => call[1].includes('--numstat'));

    expect(numstatCall).toBeGreaterThan(2);
    expect(exec.mock.invocationCallOrder[numstatCall]).toBeLessThan(
      custom.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('commits subject and body edits and returns the edited details', async () => {
    const { execute, editor, exec, custom } = fakeCommit(
      ['subject', 'body', 'approve'],
      ['fix: edited', 'Edited body'],
    );
    const result = await execute();

    expect(editor.mock.calls).toEqual([
      ['Edit subject', 'feat: add thing'],
      ['Edit body', 'Original body'],
    ]);

    expect(custom).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith('git', ['commit', '-m', 'fix: edited\n\nEdited body'], {
      cwd: '/repo',
    });

    expect(result.details.groups[0]).toMatchObject({ subject: 'fix: edited', body: 'Edited body' });
  });

  it('retains the subject when the edit is cancelled', async () => {
    const { execute, custom, previews } = fakeCommit(['subject', 'approve'], [undefined]);

    const result = await execute();

    expect(result.details.groups[0]!.subject).toBe('feat: add thing');
    expect(previews[1]).not.toContain('Invalid subject');
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it('retains the subject and shows a notice when the edit is invalid', async () => {
    const { execute, custom, previews } = fakeCommit(['subject', 'approve'], ['not conventional']);

    const result = await execute();

    expect(result.details.groups[0]!.subject).toBe('feat: add thing');
    expect(previews[1]).toContain('Invalid subject: not conventional');
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, ''])('handles a cancelled or empty body edit: %s', async (edit) => {
    const { execute } = fakeCommit(['body', 'approve'], [edit]);
    const result = await execute();

    expect(result.details.groups[0]!.body).toBe(edit ?? 'Original body');
  });

  it('opens an empty body editor when no body was supplied', async () => {
    const { execute, input, editor } = fakeCommit(['body', 'approve'], [undefined]);
    Reflect.deleteProperty(input.groups[0]!, 'body');
    const result = await execute();

    expect(editor).toHaveBeenCalledWith('Edit body', '');
    expect(result.details.groups[0]!.body).toBeNull();
  });

  it('unstages skipped groups and returns without committing', async () => {
    const { execute, exec } = fakeCommit(['skip']);
    const result = await execute();

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'TDD gate status unknown: unreadable evidence at /repo/.tau/state.json',
      },
      { type: 'text', text: 'Commit skipped by user' },
    ]);
    expect(result.details.groups[0]!.skipped).toBe(true);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );

    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
  });

  it.each(['abort', undefined])('unstages and throws on abort or dismissal: %s', async (choice) => {
    const { execute, exec } = fakeCommit([choice]);

    await expect(execute()).rejects.toThrow('Commit declined by user');
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('rejects headless calls before staging', async () => {
    const { execute, exec, context, custom } = fakeCommit(['approve']);
    context.hasUI = false;

    await expect(execute()).rejects.toThrow(
      'Cannot commit without user confirmation (non-interactive mode)',
    );

    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns without UI or git operations when already cancelled', async () => {
    const { execute, exec, custom } = fakeCommit(['approve']);

    await execute(AbortSignal.abort());

    expect(exec).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it('returns cancelled and unstages when aborted while the overlay is open', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit([]);
    custom.mockImplementation(
      (factory) =>
        new Promise<string | undefined>((resolve) => {
          void factory(
            { requestRender: () => {}, terminal: { rows: 60 } } as never,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
            {} as never,
            (result: unknown) => {
              resolve(typeof result === 'string' ? result : undefined);
            },
          );
          controller.abort();
        }),
    );

    const result = await execute(controller.signal);

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'TDD gate status unknown: unreadable evidence at /repo/.tau/state.json',
      },
      { type: 'text', text: 'Commit cancelled' },
    ]);
    expect(exec).toHaveBeenCalledWith('git', ['--literal-pathspecs', 'reset', '--', 'README.md'], {
      cwd: '/repo',
    });

    expect(exec).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit']),
      expect.anything(),
    );
  });

  it('unstages without opening UI if cancelled while staging', async () => {
    const controller = new AbortController();
    const { execute, exec, custom } = fakeCommit(['approve']);
    exec.mockImplementation((_command, commandArguments) => {
      if (commandArguments.includes('add')) {
        controller.abort();
      }

      return Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' });
    });

    await execute(controller.signal);

    expect(custom).not.toHaveBeenCalled();
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });
});
