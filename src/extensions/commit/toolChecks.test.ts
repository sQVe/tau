import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
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
  executeCommit,
  fakeCommit,
} from '../../../tests/commitTool.js';
import * as checker from './checker.js';
import { reviewGit } from './commentReview.js';
import type { reviewComments } from './commentReview.js';
import { createCommitTool as createReviewedCommitTool } from './tool.js';

it('restores a shared initial check window before review and an agent message correction', async () => {
  const root = await createTemporaryRepository();
  const output = await mkdtemp(join(tmpdir(), 'tau-check-events-'));
  temporaryDirectories.push(output);
  const events = join(output, 'events');
  const script = `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(events)}, process.argv[2] + '\\n'); if (process.argv[2] === 'message' && !fs.readFileSync(process.argv[3], 'utf8').includes('corrected')) process.exitCode = 1;`;
  await writeRepositoryFile(root, 'check.cjs', script);
  await writeRepositoryFile(
    root,
    'tau.json',
    JSON.stringify({
      check: [process.execPath, 'check.cjs', 'project'],
      checkMessage: [process.execPath, 'check.cjs', 'message'],
    }),
  );
  await writeRepositoryFile(root, 'file', 'base');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  await writeRepositoryFile(root, 'file', 'changed');
  await writeRepositoryFile(root, 'check.cjs', 'unstaged script');
  const review = vi.fn<typeof reviewComments>(async () => {
    expect(await readFile(events, 'utf8')).toMatch(/project\nmessage\n$/);
    expect(await readFile(join(root, 'check.cjs'), 'utf8')).toBe('unstaged script');
    await expect(readFile(join(root, '.git/tau-recovery/pending/archive'))).rejects.toThrow(
      /ENOENT/,
    );

    return { findings: [] };
  });
  const context = commitContext(root);
  const tool = createReviewedCommitTool(
    {
      exec: (command, arguments_, options) => runCommand(command, arguments_, options?.cwd ?? root),
    },
    review,
  );

  await expect(
    tool.execute(
      'call',
      { groups: [{ files: ['file'], subject: 'feat: initial' }] },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow(/Message check failed/);
  expect(review).not.toHaveBeenCalled();
  expect(await readFile(join(root, 'check.cjs'), 'utf8')).toBe('unstaged script');
  await expect(readFile(join(root, '.git/tau-recovery/pending/archive'))).rejects.toThrow(/ENOENT/);

  await tool.execute(
    'retry',
    { groups: [{ files: ['file'], subject: 'feat: corrected' }] },
    undefined,
    undefined,
    context,
  );

  expect(review).toHaveBeenCalledTimes(1);
  expect(await readFile(events, 'utf8')).toBe('project\nmessage\nproject\nmessage\n');
  const archives = await readdir(join(root, '.git/tau-recovery'));
  expect(archives.filter((name) => name.startsWith('prepare-'))).toHaveLength(2);
  expect(await getStoredCommitMessage(root)).toBe('feat: corrected\n');
});

it.each([false, true])(
  'pending check recovery blocks later staging cleanup with preparation %s',
  async (prepared) => {
    const root = await createTemporaryRepository();
    await writeRepositoryFile(root, 'requested', 'base');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'base']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await writeRepositoryFile(root, 'requested', 'original staged');
    await git(root, ['add', 'requested']);
    await writeRepositoryFile(root, 'requested', 'requested working');
    await writeRepositoryFile(
      root,
      'tau.json',
      JSON.stringify({
        ...(prepared ? { prepare: ['true'] } : {}),
        check: [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync('concurrent', 'checker staging'); require('node:child_process').execFileSync('git', ['add', 'concurrent']);",
        ],
      }),
    );
    const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
    const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? root),
    );
    const tool = createReviewedCommitTool({ exec }, review);
    const input = { groups: [{ files: ['requested', 'tau.json'], subject: 'feat: check' }] };

    await expect(
      tool.execute('call', input, undefined, undefined, commitContext(root)),
    ).rejects.toThrow(/Pending recovery/);
    const index = await readFile(join(root, '.git/index'));
    expect(await git(root, ['show', ':concurrent'])).toBe('checker staging');
    expect(await git(root, ['show', ':requested'])).toBe('requested working');
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(review).not.toHaveBeenCalled();
    exec.mockClear();
    await expect(
      tool.execute('retry', input, undefined, undefined, commitContext(root)),
    ).rejects.toThrow(/Commit blocked/);
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    expect(exec.mock.calls).toHaveLength(1);
  },
);

it('does not unstage concurrent changes during comment review', async () => {
  const root = await createTemporaryRepository();
  await writeRepositoryFile(root, 'tau.json', JSON.stringify({ checkMessage: ['true'] }));
  await writeRepositoryFile(root, 'requested', 'base');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  await writeRepositoryFile(root, 'requested', 'candidate');
  let index: Buffer | undefined;
  const tool = createReviewedCommitTool(
    {
      exec: (command, arguments_, options) => runCommand(command, arguments_, options?.cwd ?? root),
    },
    async () => {
      await writeRepositoryFile(root, 'requested', 'concurrent');
      await git(root, ['add', 'requested']);
      index = await readFile(join(root, '.git/index'));

      return { findings: [] };
    },
  );

  await expect(
    tool.execute(
      'call',
      { groups: [{ files: ['requested'], subject: 'feat: initial' }] },
      undefined,
      undefined,
      commitContext(root),
    ),
  ).rejects.toThrow(/changed/);
  expect(await git(root, ['show', ':requested'])).toBe('concurrent');
  expect(await readFile(join(root, '.git/index'))).toEqual(index);
});

it('blocks a recovery reservation made during review before committing', async () => {
  const { execute, review, exec, gitDirectory } = fakeCommit();
  review.mockImplementationOnce(async () => {
    await mkdir(join(gitDirectory, 'tau-recovery/pending'), { recursive: true });

    return { findings: [] };
  });

  await expect(execute()).rejects.toThrow(/Commit blocked/);
  expect(exec.mock.calls.filter(([, arguments_]) => arguments_.includes('commit'))).toHaveLength(0);
});

it('restores working files but retains both messages when a checker rewrites the message', async () => {
  const root = await createTemporaryRepository();
  const marker = join(root, '.git/message-path');
  await writeRepositoryFile(
    root,
    'tau.json',
    JSON.stringify({
      checkMessage: [
        process.execPath,
        '-e',
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, process.argv[1]); fs.writeFileSync(process.argv[1], 'checker rewrite');`,
      ],
    }),
  );
  await writeRepositoryFile(root, 'requested', 'value');
  await writeRepositoryFile(root, 'untracked', 'user bytes');
  const tool = createCommitTool({
    exec: (command, arguments_, options) => runCommand(command, arguments_, options?.cwd ?? root),
  });

  await expect(
    tool.execute(
      'call',
      { groups: [{ files: ['requested', 'tau.json'], subject: 'feat: original' }] },
      undefined,
      undefined,
      commitContext(root),
    ),
  ).rejects.toThrow(/Message check changed/);
  const message = await readFile(marker, 'utf8');
  temporaryDirectories.push(dirname(message));
  expect(await readFile(join(root, 'untracked'), 'utf8')).toBe('user bytes');
  expect(await readFile(message, 'utf8')).toBe('checker rewrite');
  expect(await readFile(`${message}.original`, 'utf8')).toBe('feat: original\n');
});

it('checks the absolute fixture Git directory in mocked commit flows', async () => {
  const { execute, exec, gitDirectory } = fakeCommit();
  await mkdir(join(gitDirectory, 'tau-recovery/pending'), { recursive: true });

  await expect(execute()).rejects.toThrow(gitDirectory);
  expect(exec.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
    ['rev-parse', '--absolute-git-dir'],
  ]);
});

it('blocks incomplete pending recovery before preparation staging or review', async () => {
  const directory = await createTemporaryRepository();
  await mkdir(join(directory, '.git/tau-recovery/pending'), { recursive: true });
  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_) =>
    runCommand(command, arguments_, directory),
  );
  const review = vi.fn<typeof reviewComments>(async () => ({ findings: [] }));
  const tool = createReviewedCommitTool({ exec }, review);

  await expect(
    tool.execute(
      'pending',
      {
        groups: [{ files: ['file'], subject: 'fix: blocked' }],
      },
      undefined,
      undefined,
      commitContext('/repo'),
    ),
  ).rejects.toThrow(directory);
  expect(exec.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
    ['rev-parse', '--absolute-git-dir'],
  ]);
  expect(review).not.toHaveBeenCalled();
});

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
      commitContext(directory),
    ),
  ).rejects.toThrow(/not a git repository/i);
  expect(exec.mock.calls.map(([command, arguments_]) => [command, arguments_])).toEqual([
    ['git', ['rev-parse', '--absolute-git-dir']],
  ]);
  expect(await readFile(join(directory, 'tau.json'), 'utf8')).toBe(config);
  await expect(readFile(join(directory, 'mutated'))).rejects.toThrow(/ENOENT/);
  await expect(readFile(join(directory, 'checked'))).rejects.toThrow(/ENOENT/);
});

it('prepares each executed group after staging and reviews prepared bytes', async () => {
  const directory = await createTemporaryRepository();

  await writeRepositoryFile(
    directory,
    'tau.json',
    JSON.stringify({
      prepare: [
        'node',
        '-e',
        `const fs = require('node:fs'); const cp = require('node:child_process'); const paths = cp.execFileSync('git', ['diff', '--cached', '--name-only', '-z']).toString().split('\\0').filter(Boolean); if (paths.length !== 1) throw Error('expected one staged path'); fs.writeFileSync(paths[0], 'prepared');`,
      ],
      check: [
        'node',
        '-e',
        `const fs = require('node:fs'); if (!['one', 'two'].some(path => fs.readFileSync(path, 'utf8') === 'prepared')) process.exit(1);`,
      ],
    }),
  );
  await writeRepositoryFile(directory, 'one', 'base');
  await writeRepositoryFile(directory, 'two', 'base');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'test: baseline']);
  await writeRepositoryFile(directory, 'one', 'dirty');
  await writeRepositoryFile(directory, 'two', 'dirty');

  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? directory),
  );
  const review = vi.fn<typeof reviewComments>(async (_pi, _context, _signal, snapshot) => {
    expect(
      await git(directory, [
        'show',
        `${snapshot.tree}:${review.mock.calls.length === 1 ? 'one' : 'two'}`,
      ]),
    ).toBe('prepared');

    return { findings: [] };
  });
  const tool = createReviewedCommitTool({ exec }, review);
  const result = await tool.execute(
    'groups',
    {
      groups: [
        { files: ['one'], subject: 'feat: one' },
        { files: ['two'], subject: 'feat: two' },
      ],
    },
    undefined,
    undefined,
    commitContext(directory),
  );

  expect(result.details.groups).toHaveLength(2);
  expect(review).toHaveBeenCalledTimes(2);
  expect(
    exec.mock.calls.filter(([, arguments_]) =>
      arguments_.some((argument) => argument.includes('expected one staged path')),
    ),
  ).toHaveLength(2);
  expect(await git(directory, ['show', 'HEAD:two'])).toBe('prepared');
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
  '{"checkMessage":null}',
  '{"checkMessage":[]}',
  '{"checkMessage":"make check"}',
  '{"checkMessage":[" "]}',
  '{"checkMessage":["make",1]}',
  '{"checkMessage":["make","\\u0000"]}',
  '{"hooks":null}',
  '{"hooks":[]}',
  '{"hooks":"Skip"}',
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

it('rejects obsolete invalid and unknown settings before preparation or staging', async () => {
  const repositoryDirectory = await createTemporaryRepository();
  const exec = vi.fn<ExtensionAPI['exec']>((command, arguments_, options) =>
    runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
  );
  const tool = createCommitTool({ exec });
  const settings = [
    { fix: ['make', 'format'] },
    { checkMessage: [] },
    { hooks: false },
    { hooks: 'skipp' },
    { chek: ['make', 'check'] },
    { check: [] },
  ];
  const errors = [
    /fix.*rename.*prepare/i,
    /checkMessage.*nonempty/i,
    /hooks.*run.*skip/i,
    /hooks.*run.*skip/i,
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
        commitContext(repositoryDirectory),
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

it('reports a failing preparation without opening UI', async () => {
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

it('rejects an array as the root config before staging', async () => {
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
  await writeFile(join(repositoryDirectory, '.git/info/exclude'), 'node_modules\n');

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

  vi.spyOn(checker, 'runChecker').mockImplementation(async (command, root, signal) => {
    controller.abort();

    return realChecker(command, root, signal);
  });
  const commitTool = createCommitTool({
    exec: (command, arguments_, options) =>
      runCommand(command, arguments_, options?.cwd ?? repositoryDirectory),
  });

  const result = await commitTool.execute(
    'tool-call-1',
    { groups: [{ files: ['tau.json', 'check.cjs'], subject: 'feat: check' }] },
    controller.signal,
    undefined,
    commitContext(repositoryDirectory),
  );

  const currentHead = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const stagedFiles = await git(repositoryDirectory, ['diff', '--cached', '--name-only']);

  expect(result.content).toEqual([{ type: 'text', text: 'Commit cancelled' }]);
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
      if (command === 'env' && commandArguments.includes('prepare.cjs')) {
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
    commitContext(repositoryDirectory),
  );

  const currentHead = await git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const stagedFiles = await git(repositoryDirectory, ['diff', '--cached', '--name-only']);

  expect(result.content[0]).toEqual({ type: 'text', text: 'Commit cancelled' });
  expect(JSON.stringify(result.content[1])).toContain('Recovery saved at');
  expect(currentHead).toBe(head);
  expect(stagedFiles).toBe('');
});

it.each(['pass', 'fail', 'killed', 'cancel'] as const)(
  'restores the checkout after check result: %s',
  async (outcome) => {
    const repositoryDirectory = await createTemporaryRepository();
    const controller = new AbortController();
    let candidateDirectory = '';

    await writeRepositoryFile(
      repositoryDirectory,
      'tau.json',
      JSON.stringify({ check: ['check-command', ''] }),
    );

    const exec: ExtensionAPI['exec'] = (command, arguments_, options) => {
      if (command !== 'check-command') {
        return runCommand(command, arguments_, options?.cwd ?? repositoryDirectory);
      }

      candidateDirectory = options?.cwd ?? '';
      expect(candidateDirectory).toBe(repositoryDirectory);
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
    };
    useCheckerExec(exec);
    const tool = createCommitTool({ exec });
    const result = tool.execute(
      'cleanup',
      {
        groups: [{ files: ['tau.json'], subject: 'chore: configure check' }],
      },
      controller.signal,
      undefined,
      commitContext(repositoryDirectory),
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
    expect(await readFile(join(candidateDirectory, 'tau.json'), 'utf8')).toContain('check-command');
    await expect(
      readFile(join(candidateDirectory, '.git/tau-recovery/pending/archive')),
    ).rejects.toThrow(/ENOENT/);
    expect(await git(repositoryDirectory, ['diff', '--cached', '--name-only'])).toBe('');
  },
);

it('rejects check-time formatting and retains original and checker bytes', async () => {
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
  ).rejects.toThrow(/Checker changed.*Pending recovery/s);
  expect(await readFile(join(repositoryDirectory, 'value.cjs'), 'utf8')).toBe(
    'module.exports = 2;',
  );
  const archive = await readFile(
    join(repositoryDirectory, '.git/tau-recovery/pending/archive'),
    'utf8',
  );
  const saved = await readFile(
    join(repositoryDirectory, '.git/tau-recovery', archive, 'working.json'),
    'utf8',
  );
  expect(JSON.parse(saved)).toMatchObject({
    'value.cjs': { content: Buffer.from('module.exports = (2);').toString('base64') },
  });
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
