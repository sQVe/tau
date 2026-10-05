import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { readReviewEvidence } from './evidence.js';
import { writeCaptureRecord } from './record.js';
import { captureTarget, pinTarget, readHead } from './reviewCapture.js';
import type { ReviewTarget } from './reviewCapture.js';

const isRoot = process.getuid?.() === 0;

const git = async (root: string, commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout.trim();
};

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

const commit = async (root: string, files: Record<string, string>, message: string) => {
  await writeFiles(root, files);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--quiet', '-m', message]);

  return git(root, ['rev-parse', 'HEAD']);
};

const inputText = (rules: string, checks: string) =>
  `# Review input\n\n## Rules\n\n${rules}\n\n## Checks\n\n${checks}\n\n## Capture\n`;

const savedCapture = async (
  root: string,
  target: ReviewTarget,
  input = inputText('None.', 'none'),
) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-review-evidence-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const pinned = await pinTarget(root, target);
  const captured = await captureTarget(root, pinned);
  const { head } = await readHead(root);
  const base = pinned.kind === 'range' ? pinned.from : null;

  await writeFile(join(directory, 'input.md'), `${input}\n${captured.bytes.toString('utf8')}`);

  await writeCaptureRecord(directory, {
    version: 1,
    target: pinned,
    base,
    head: head ?? '',
    hash: captured.hash,
  });

  return directory;
};

const sourceFiles = {
  'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'src/math.test.ts': "import { add } from './math.js';\n\nadd(1, 2);\n",
  'src/use.ts': "import { add } from './math.js';\n\nexport const three = add(1, 2);\n",
};

const rangeRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const from = await commit(root, sourceFiles, 'first');

  const to = await commit(
    root,
    {
      'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
      'src/math.test.ts': "import { add } from './math.js';\n\nadd(2, 1);\n",
      'src/use.ts': "import { add } from './math.js';\n\nexport const four = add(2, 2);\n",
    },
    'second',
  );

  return { root, from, to };
};

it('reads test bodies and callers at the end of a range, not from the working tree', async () => {
  const { root, from, to } = await rangeRepository();
  const directory = await savedCapture(root, { kind: 'range', from, to });

  await writeFiles(root, {
    'src/math.test.ts': "import { add } from './math.js';\n\nadd(9, 9);\n",
    'src/use.ts': "import { add } from './math.js';\n\nexport const nine = add(9, 9);\n",
    'src/later.ts': "import { add } from './math.js';\n",
  });

  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.tests).toEqual([
    {
      path: 'src/math.test.ts',
      lines: [
        { line: 1, text: "import { add } from './math.js';" },
        { line: 2, text: '' },
        { line: 3, text: 'add(2, 1);' },
      ],
    },
  ]);

  expect(evidence.callers).toEqual([
    {
      module: 'src/math.ts',
      path: 'src/use.ts',
      line: 1,
      text: "import { add } from './math.js';",
    },
  ]);
});

it('finds callers outside test files and the module itself in a working tree target', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const base = await commit(root, sourceFiles, 'first');

  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
    'src/nested/other.ts': "export { add } from '../math.js';\n",
    'src/unrelated.ts': "import { add } from './vendor/math.js';\n",
  });

  const directory = await savedCapture(root, { kind: 'workingTree', base });
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.callers).toEqual([
    {
      module: 'src/math.ts',
      path: 'src/nested/other.ts',
      line: 1,
      text: "export { add } from '../math.js';",
    },
    {
      module: 'src/math.ts',
      path: 'src/use.ts',
      line: 1,
      text: "import { add } from './math.js';",
    },
  ]);
});

it('does not read a sibling test that links outside the repository', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const outside = await mkdtemp(join(tmpdir(), 'tau-review-outside-'));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));

  const base = await commit(root, { 'src/math.ts': sourceFiles['src/math.ts'] }, 'first');

  await writeFile(join(outside, 'secret.ts'), 'secret\n');
  await symlink(join(outside, 'secret.ts'), join(root, 'src/math.test.ts'));

  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
  });

  const directory = await savedCapture(root, { kind: 'files', paths: ['src/math.ts'], base });
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.tests).toEqual([]);
  expect(evidence.gaps).toContainEqual({ kind: 'unreadable', path: 'src/math.test.ts' });
});

it('writes nothing to the review directory except the freshness recapture', async () => {
  const { root, from, to } = await rangeRepository();
  const directory = await savedCapture(root, { kind: 'range', from, to });
  const before = await readdir(directory);

  await readReviewEvidence(root, directory);

  expect((await readdir(directory)).toSorted()).toEqual([...before, 'recheck.diff'].toSorted());
});

it('refuses a review directory without capture.json', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await mkdtemp(join(tmpdir(), 'tau-review-evidence-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  await expect(readReviewEvidence(root, directory)).rejects.toThrow('No capture record');
  expect(await readdir(directory)).toEqual([]);
});

it('refuses a malformed capture.json', async () => {
  const { root, from, to } = await rangeRepository();
  const directory = await savedCapture(root, { kind: 'range', from, to });

  await writeFile(join(directory, 'capture.json'), '{"version": 1, "target": {}}');

  await expect(readReviewEvidence(root, directory)).rejects.toThrow('Malformed capture record');
  expect((await readdir(directory)).toSorted()).toEqual(['capture.json', 'input.md']);
});

it('reports a stale capture as a gap and still returns the evidence', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const base = await commit(root, sourceFiles, 'first');

  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
  });

  const directory = await savedCapture(root, { kind: 'workingTree', base });

  await writeFiles(root, { 'src/math.ts': 'export const add = (a: number, b: number) => 0;\n' });

  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.freshness.status).toBe('stale');
  expect(evidence.paths).toEqual(['src/math.ts']);

  expect(evidence.gaps).toContainEqual({
    kind: 'freshness',
    status: 'stale',
    reasons: evidence.freshness.reasons,
  });
});

it('marks named rule and check paths readable or missing', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const base = await commit(root, { ...sourceFiles, 'AGENTS.md': '# Rules\n' }, 'first');

  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
  });

  const input = inputText(
    '- `AGENTS.md`\n- [ADR](docs/adr/0001.md)\n- run `pnpm check`',
    'Saved at `.tau/check.log`.',
  );

  const directory = await savedCapture(root, { kind: 'workingTree', base }, input);
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.rules).toEqual([
    { path: 'AGENTS.md', status: 'readable' },
    { path: 'docs/adr/0001.md', status: 'missing' },
  ]);

  expect(evidence.checks).toEqual([{ path: '.tau/check.log', status: 'missing' }]);

  expect(evidence.gaps).toContainEqual({
    kind: 'missing',
    path: 'docs/adr/0001.md',
    section: 'rules',
  });

  expect(evidence.gaps).toContainEqual({
    kind: 'missing',
    path: '.tau/check.log',
    section: 'checks',
  });
});

it('checks rule paths of a range at its end and check paths on the filesystem', async () => {
  const { root, from, to } = await rangeRepository();

  await writeFiles(root, { 'AGENTS.md': '# Rules\n', '.tau/check.log': 'passed\n' });
  await rm(join(root, 'src/use.ts'));

  const input = inputText('- `AGENTS.md`\n- `src/use.ts`', 'Saved at `.tau/check.log`.');
  const directory = await savedCapture(root, { kind: 'range', from, to }, input);
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.rules).toEqual([
    { path: 'AGENTS.md', status: 'missing' },
    { path: 'src/use.ts', status: 'readable' },
  ]);

  expect(evidence.checks).toEqual([{ path: '.tau/check.log', status: 'readable' }]);
  expect(evidence.gaps).toContainEqual({ kind: 'missing', path: 'AGENTS.md', section: 'rules' });
});

it.skipIf(isRoot)('reports an unreadable named rule file as a gap', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const base = await commit(root, sourceFiles, 'first');

  await writeFiles(root, { 'private.md': 'hidden\n' });
  await chmod(join(root, 'private.md'), 0o000);

  const input = inputText('- `private.md`', 'none');
  const directory = await savedCapture(root, { kind: 'workingTree', base }, input);
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.rules).toEqual([{ path: 'private.md', status: 'unreadable' }]);
  expect(evidence.gaps).toContainEqual({ kind: 'unreadable', path: 'private.md' });
});

it.skipIf(isRoot)('keeps callers and reports a caller search that skipped paths', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const base = await commit(root, sourceFiles, 'first');

  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
    'src/private/hidden.ts': "import { add } from '../math.js';\n",
  });

  await chmod(join(root, 'src/private'), 0o000);
  onTestFinished(() => chmod(join(root, 'src/private'), 0o700));

  const directory = await savedCapture(root, { kind: 'workingTree', base });
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.callers.map((caller) => caller.path)).toEqual(['src/use.ts']);

  expect(evidence.gaps).toContainEqual({
    kind: 'incompleteSearch',
    path: 'src/math.ts',
    reason: expect.stringContaining('private') as unknown,
  });
});

it('keeps a newline in a caller path', async () => {
  const { root, from } = await rangeRepository();

  const to = await commit(
    root,
    { 'src/newline\ncaller.ts': "import { add } from './math.js';\n" },
    'third',
  );

  const directory = await savedCapture(root, { kind: 'range', from, to });
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.callers.map((caller) => [caller.path, caller.line])).toEqual([
    ['src/newline\ncaller.ts', 1],
    ['src/use.ts', 1],
  ]);
});

it('lists a caller that holds a NUL byte', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const base = await commit(
    root,
    {
      ...sourceFiles,
      'src/binary.mjs': "import { add } from './math.js';\nconst marker = '\0';\n",
    },
    'first',
  );

  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => b + a;\n',
  });

  const directory = await savedCapture(root, { kind: 'workingTree', base });
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.callers.map((caller) => [caller.path, caller.line])).toEqual([
    ['src/binary.mjs', 1],
    ['src/use.ts', 1],
  ]);
});

it('does not count a plain path string as a caller', async () => {
  const { root, from } = await rangeRepository();

  const to = await commit(
    root,
    { 'src/probe.ts': "export const examplePath = './math.js';\n" },
    'third',
  );

  const directory = await savedCapture(root, { kind: 'range', from, to });
  const evidence = await readReviewEvidence(root, directory);

  expect(evidence.callers.map((caller) => caller.path)).toEqual(['src/use.ts']);
});

it('reports a cut list and a cut body as gaps', async () => {
  const { root, from, to } = await rangeRepository();
  const directory = await savedCapture(root, { kind: 'range', from, to });

  const limits = {
    paths: 2,
    testFiles: 5,
    bodyLines: 1,
    callersPerModule: 5,
    callers: 5,
    namedPaths: 5,
  };

  const evidence = await readReviewEvidence(root, directory, limits);

  expect(evidence.paths).toEqual(['src/math.test.ts', 'src/math.ts']);
  expect(evidence.tests.map((test) => test.lines.length)).toEqual([1]);
  expect(evidence.gaps).toContainEqual({ kind: 'truncatedList', list: 'paths', kept: 2, total: 3 });

  expect(evidence.gaps).toContainEqual({
    kind: 'truncatedBody',
    path: 'src/math.test.ts',
    kept: 1,
    total: 3,
  });
});
