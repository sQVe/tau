import { argumentAfter } from '../../../../tests/execFake.js';

interface FakeJob {
  name: string;
  conclusion: string;
}

export interface FakeTrunkRun {
  id: number;
  branch: string;
  event?: string;
  workflow: string;
  conclusion: string;
  headSha: string;
  jobs: FakeJob[];
  // gh run list --workflow skips a disabled workflow's runs unless --all is passed.
  workflowDisabled?: boolean;
}

const includesDisabled = (commandArguments: readonly string[]) =>
  commandArguments.includes('--all');

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
    .filter((run) => {
      const event = argumentAfter(commandArguments, '--event');

      return event === undefined || (run.event ?? 'push') === event;
    })
    .filter((run) => run.workflowDisabled !== true || includesDisabled(commandArguments))
    .slice(0, Number(argumentAfter(commandArguments, '--limit')))
    .map((run) => ({
      databaseId: run.id,
      conclusion: run.conclusion,
      headSha: run.headSha,
      url: `https://${repository}/actions/runs/${run.id}`,
    }));

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
