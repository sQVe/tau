import { argumentAfter } from '../../../../tests/execFake.js';

interface FakeJob {
  name: string;
  conclusion: string;
}

export interface FakeTrunkRun {
  id: number;
  branch: string;
  workflow: string;
  conclusion: string;
  headSha: string;
  jobs: FakeJob[];
}

// Answers `gh run list --branch <trunk> --workflow <workflow> --limit <n>`.
export const trunkRunList = (
  trunkRuns: readonly FakeTrunkRun[],
  repository: string,
  commandArguments: readonly string[],
): unknown =>
  trunkRuns
    .filter(
      (run) =>
        run.branch === argumentAfter(commandArguments, '--branch') &&
        run.workflow === argumentAfter(commandArguments, '--workflow'),
    )
    .slice(0, Number(argumentAfter(commandArguments, '--limit')))
    .map((run) => ({
      databaseId: run.id,
      conclusion: run.conclusion,
      headSha: run.headSha,
      url: `https://${repository}/actions/runs/${run.id}`,
    }));

// Answers `gh run view <id> --json jobs`.
export const trunkRunJobs = (
  trunkRuns: readonly FakeTrunkRun[],
  commandArguments: readonly string[],
): unknown => {
  const run = trunkRuns.find((candidate) => String(candidate.id) === commandArguments[2]);

  if (run === undefined) {
    throw new Error(`run ${commandArguments[2]} not found`);
  }

  return { jobs: run.jobs };
};
