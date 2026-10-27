import { Type } from 'typebox';
import type { Static, TArray, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { CommandRuntime } from '../../command.js';
import {
  incompleteListProblem,
  label,
  pullRequestListArguments,
  runOutcome,
} from '../../github/github.js';
import type { Repository } from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import { describeSchemaProblem } from '../../schema.js';
import type { PullView } from './chainDecisions.js';
import { readStacksResponse } from './checkDecisions.js';
import type { BasedPull, HeadPull, StackedPullRequests, StackViewRead } from './checkDecisions.js';
import { failedExit, ghCommandOutput, malformedOutput, readFailed, readOk } from './readResult.js';
import type { CommandOutput, Read } from './readResult.js';

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

const readGh = async (runtime: CommandRuntime, commandArguments: string[]) =>
  ghCommandOutput(await runOutcome(runtime, commandArguments));

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

const listPulls = async <Schema extends TArray>(
  runtime: CommandRuntime,
  commandArguments: string[],
  schema: Schema,
): Promise<Read<Static<Schema>>> => {
  const command = label(commandArguments);
  const read = parseJsonOutput(command, await readGh(runtime, commandArguments), schema);

  const problem = read.ok ? incompleteListProblem(read.value) : undefined;

  return problem === undefined ? read : readFailed(command, problem);
};

// Only an exit 0 run has output to read. Any other exit code is a result in itself.
export const readStackViewFacts = async (runtime: CommandRuntime): Promise<StackViewRead> => {
  const output = await readGh(runtime, ['stack', 'view', '--json']);

  if (output.exitCode !== 0) {
    return { exitCode: output.exitCode, view: null };
  }

  return { exitCode: 0, view: parseJsonOutput(stackViewCommand, output, stackViewSchema) };
};

export const readHeadPulls = (
  runtime: CommandRuntime,
  repository: Repository,
  branch: string,
): Promise<Read<HeadPull[]>> =>
  listPulls(
    runtime,
    pullRequestListArguments({
      repository: formatRepository(repository),
      filter: ['--head', branch],
      state: 'open',
      fields: headPullFields,
    }),
    headPullSchema,
  );

export const readBasedOnPulls = (
  runtime: CommandRuntime,
  repository: Repository,
  branch: string,
): Promise<Read<BasedPull[]>> =>
  listPulls(
    runtime,
    pullRequestListArguments({
      repository: formatRepository(repository),
      filter: ['--base', branch],
      state: 'open',
      fields: 'number,url,headRefName',
    }),
    basedPullSchema,
  );

export const readStacks = async (
  runtime: CommandRuntime,
  repository: Repository,
  number: number,
): Promise<Read<StackedPullRequests>> => {
  const commandArguments = [
    'api',
    '--hostname',
    repository.host,
    `repos/${repository.owner}/${repository.name}/stacks?pull_request=${number}`,
  ];

  return readStacksResponse(label(commandArguments), await readGh(runtime, commandArguments));
};

export const readPullView = (
  runtime: CommandRuntime,
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

  return readGh(runtime, commandArguments).then((output) =>
    parseJsonOutput(label(commandArguments), output, pullViewSchema),
  );
};

export const readDefaultBranch = async (
  runtime: CommandRuntime,
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
    await readGh(runtime, commandArguments),
    defaultBranchSchema,
  );

  return read.ok ? readOk(read.value.defaultBranchRef.name) : read;
};
