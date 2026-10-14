import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { label } from '../../github.js';
import type { Repository, Runtime } from '../../github.js';
import { runGit } from '../../gitOutput.js';
import { formatRepository } from '../../repositoryTargetDecisions.js';
import { describeSchemaProblem } from '../../schemaProblem.js';
import type { PullView } from './chainDecisions.js';
import { readStacksResponse } from './checkDecisions.js';
import type { BasedPull, HeadPull, StackedPullRequests, StackViewRead } from './checkDecisions.js';
import { failedExit, malformedOutput, readFailed, readOk } from './readResult.js';
import type { CommandOutput, Read } from './readResult.js';

// gh pr list prints at most --limit pull requests and does not say when it left some out.
const listLimit = 100;

const headPullFields = 'number,url,baseRefName,headRepositoryOwner,headRepository';

const headPullSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    url: Type.String(),
    baseRefName: Type.String(),
    headRepositoryOwner: Type.Object({ login: Type.String() }),
    headRepository: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  }),
);

const basedPullSchema = Type.Array(
  Type.Object({ number: Type.Integer(), url: Type.String(), headRefName: Type.String() }),
);

const stackViewSchema = Type.Object({
  trunk: Type.String(),
  currentBranch: Type.String(),
  branches: Type.Array(
    Type.Object({
      name: Type.String(),
      head: Type.String(),
      base: Type.String(),
      isCurrent: Type.Boolean(),
      isMerged: Type.Boolean(),
      isQueued: Type.Boolean(),
      needsRebase: Type.Boolean(),
      pr: Type.Optional(
        Type.Union([
          Type.Object({ number: Type.Integer(), url: Type.String(), state: Type.String() }),
          Type.Null(),
        ]),
      ),
    }),
  ),
});

const stackViewCommand = 'gh stack view --json';

const pullViewSchema = Type.Object({
  number: Type.Integer(),
  headRefName: Type.String(),
  baseRefName: Type.String(),
  state: Type.String(),
});

const defaultBranchSchema = Type.Object({ defaultBranchRef: Type.Object({ name: Type.String() }) });

const runGh = async (runtime: Runtime, commandArguments: string[]): Promise<CommandOutput> => {
  const result = await runtime.exec('gh', commandArguments, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  return {
    exitCode: result.killed ? null : result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export const runGitRead = async (
  cwd: string,
  commandArguments: string[],
): Promise<CommandOutput> => {
  try {
    const result = await runGit(cwd, commandArguments);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

export const gitLabel = (commandArguments: readonly string[]): string =>
  ['git', ...commandArguments].join(' ');

const parseJsonOutput = <Schema extends TSchema>(
  command: string,
  output: CommandOutput,
  schema: Schema,
): Read<Static<Schema>> => {
  if (output.exitCode !== 0) {
    return failedExit(command, output);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    return malformedOutput(command, output);
  }

  if (!Value.Check(schema, parsed)) {
    return readFailed(
      command,
      `printed unexpected output: ${describeSchemaProblem(schema, parsed)}`,
    );
  }

  return readOk(parsed);
};

const listPulls = async <Schema extends TSchema>(
  runtime: Runtime,
  commandArguments: string[],
  schema: Schema,
): Promise<Read<Static<Schema>>> => {
  const command = label(commandArguments);
  const read = parseJsonOutput(command, await runGh(runtime, commandArguments), schema);

  if (read.ok && Array.isArray(read.value) && read.value.length >= listLimit) {
    return readFailed(
      command,
      `printed ${read.value.length} pull requests, the limit, so the list may be incomplete.`,
    );
  }

  return read;
};

// Only an exit 0 run has output to read. Any other exit code is a result in itself.
export const readStackViewFacts = async (runtime: Runtime): Promise<StackViewRead> => {
  const output = await runGh(runtime, ['stack', 'view', '--json']);

  if (output.exitCode !== 0) {
    return { exitCode: output.exitCode, view: null };
  }

  return { exitCode: 0, view: parseJsonOutput(stackViewCommand, output, stackViewSchema) };
};

export const readHeadPulls = (
  runtime: Runtime,
  repository: Repository,
  branch: string,
): Promise<Read<HeadPull[]>> =>
  listPulls(
    runtime,
    [
      'pr',
      'list',
      '--repo',
      formatRepository(repository),
      '--head',
      branch,
      '--state',
      'open',
      '--limit',
      String(listLimit),
      '--json',
      headPullFields,
    ],
    headPullSchema,
  );

export const readBasedOnPulls = (
  runtime: Runtime,
  repository: Repository,
  branch: string,
): Promise<Read<BasedPull[]>> =>
  listPulls(
    runtime,
    [
      'pr',
      'list',
      '--repo',
      formatRepository(repository),
      '--base',
      branch,
      '--state',
      'open',
      '--limit',
      String(listLimit),
      '--json',
      'number,url,headRefName',
    ],
    basedPullSchema,
  );

export const readStacks = async (
  runtime: Runtime,
  repository: Repository,
  number: number,
): Promise<Read<StackedPullRequests>> => {
  const commandArguments = [
    'api',
    '--hostname',
    repository.host,
    `repos/${repository.owner}/${repository.name}/stacks?pull_request=${number}`,
    '--jq',
    '.[0] // {} | {number, pullRequests: ((.pull_requests // []) | map(.number))}',
  ];

  return readStacksResponse(label(commandArguments), await runGh(runtime, commandArguments));
};

export const readPullView = (
  runtime: Runtime,
  repository: Repository,
  pull: number | string,
): Promise<Read<PullView>> => {
  const commandArguments = [
    'pr',
    'view',
    String(pull),
    '--repo',
    formatRepository(repository),
    '--json',
    'number,headRefName,baseRefName,state',
  ];

  return runGh(runtime, commandArguments).then((output) =>
    parseJsonOutput(label(commandArguments), output, pullViewSchema),
  );
};

export const readDefaultBranch = async (
  runtime: Runtime,
  repository: Repository,
): Promise<Read<string>> => {
  const commandArguments = [
    'repo',
    'view',
    formatRepository(repository),
    '--json',
    'defaultBranchRef',
  ];

  const read = parseJsonOutput(
    label(commandArguments),
    await runGh(runtime, commandArguments),
    defaultBranchSchema,
  );

  return read.ok ? readOk(read.value.defaultBranchRef.name) : read;
};
