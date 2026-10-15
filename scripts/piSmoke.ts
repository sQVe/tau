import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { smokeCommitFile, smokeCommitSubject, smokeFailures } from './piSmokeChecks.ts';
import type { GitFacts } from './piSmokeChecks.ts';
import { installedPiPath } from './piVersionDrift.ts';

const usage = `Usage: node scripts/piSmoke.ts [--pi <binary>] [--tau <checkout>] [--model <pattern>]

--pi defaults to the installed pi on PATH. --tau defaults to this checkout.`;

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piTimeoutMilliseconds = 600_000;
const outputLimitBytes = 268_435_456;
const stderrExcerptLength = 500;

const prompt = `This is an automated smoke test. Make exactly these tool calls, in this order, with no other tool calls and no other changes.
1. Call run_tests with behavior "answer", testFullName "answer returns 41", files ["src/answer.test.ts"], scope "focused".
2. Call edit on src/answer.ts: replace the line "export const answer = () => 41;" with "export const answer = () => 41; // checked".
3. Call commit with one group: files ["${smokeCommitFile}"], subject "${smokeCommitSubject}".
4. Call codemode with this script: const result = await tools.bash({ command: "printf tau-smoke-%s $((7000+431))" }); return result.output;
After step 4, reply with the word done.`;

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  return result.stdout;
};

const createScratchRepository = (tau: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-pi-smoke-repo-'));

  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, '.gitignore'), 'node_modules\n');
  writeFileSync(join(directory, 'package.json'), '{ "name": "smoke", "type": "module" }\n');
  writeFileSync(join(directory, 'src', 'answer.ts'), 'export const answer = () => 41;\n');

  writeFileSync(
    join(directory, 'src', 'answer.test.ts'),
    [
      "import { expect, test } from 'vitest';",
      '',
      "import { answer } from './answer.ts';",
      '',
      "test('answer returns 41', () => {",
      '  expect(answer()).toBe(41);',
      '});',
      '',
    ].join('\n'),
  );

  symlinkSync(join(tau, 'node_modules'), join(directory, 'node_modules'));
  git(directory, ['init', '--quiet', '--initial-branch', 'main']);
  git(directory, ['config', 'user.name', 'Smoke']);
  git(directory, ['config', 'user.email', 'smoke@example.com']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '--message', 'chore: initial']);

  return directory;
};

const readGitFacts = (repository: string): GitFacts => {
  const log = git(repository, ['log', '--format=%x00%s', '--name-only']);

  const commits = log
    .split('\0')
    .slice(1)
    .map((entry) => {
      const [subject = '', ...files] = entry.split('\n').filter((line) => line.length > 0);

      return { subject, files };
    });

  return { commits };
};

const run = (): number => {
  const { values } = parseArgs({
    options: {
      pi: { type: 'string' },
      tau: { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean' },
    },
  });

  if (values.help === true) {
    process.stdout.write(`${usage}\n`);

    return 0;
  }

  const tau = resolve(values.tau ?? checkoutRoot);
  const repository = createScratchRepository(tau);
  const eventLog = join(mkdtempSync(join(tmpdir(), 'tau-pi-smoke-log-')), 'events.jsonl');

  const piArguments = [
    '--print',
    '--mode',
    'json',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '-e',
    'builtin:codemode',
    '-e',
    tau,
  ];

  if (values.model !== undefined) {
    piArguments.push('--model', values.model);
  }

  piArguments.push(prompt);

  const result = spawnSync(values.pi ?? 'pi', piArguments, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: outputLimitBytes,
    timeout: piTimeoutMilliseconds,
    // oxlint-disable-next-line node/no-process-env -- pi reads its credentials and PATH from the caller's environment.
    env: { ...process.env, PATH: installedPiPath(process.env.PATH ?? '', delimiter) },
  });

  const failures: string[] = [];

  // A spawn failure leaves stdout null despite its type; a timeout keeps partial events.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- the type omits the null case.
  writeFileSync(eventLog, result.stdout ?? '');
  process.stdout.write(`Event log: ${eventLog}\n`);

  if (result.error !== undefined) {
    process.stderr.write(`FAIL pi run: expected pi to finish, got ${result.error.message}\n`);
    process.stderr.write(`Scratch repository kept at ${repository}\n`);

    return 1;
  }

  if (result.status !== 0) {
    failures.push(
      `pi exit status: expected 0, got ${result.status}: ${result.stderr.slice(0, stderrExcerptLength)}`,
    );
  }

  const lines = result.stdout.split('\n').filter((line) => line.length > 0);

  failures.push(...smokeFailures(lines, readGitFacts(repository)));

  if (failures.length === 0) {
    rmSync(repository, { recursive: true, force: true });
    process.stdout.write('Pi smoke test passed.\n');

    return 0;
  }

  for (const failure of failures) {
    process.stderr.write(`FAIL ${failure}\n`);
  }

  process.stderr.write(`Scratch repository kept at ${repository}\n`);

  return 1;
};

process.exitCode = run();
