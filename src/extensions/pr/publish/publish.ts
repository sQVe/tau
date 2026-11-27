import type { CommandRuntime } from '../../../command.js';
import { requireValue } from '../prRun.js';
import { decidePublication, publicationToken } from './publishDecisions.js';
import { publishedUrl, runWithVerifiedBytes } from './publishExecution.js';
import type { PublicationKind } from './publishKind.js';
import { planPublication, publicationTarget } from './publishPlan.js';
import type { PublicationFinding, PublishRequest } from './publishPlan.js';

export interface DryRunResult {
  kind: PublicationKind;
  token: string;
  findings: PublicationFinding[];
}

export interface PublishResult {
  kind: PublicationKind;
  files: string[];
  url: string | null;
}

export const readPublication = async (
  root: string,
  request: PublishRequest,
): Promise<DryRunResult> => {
  const target = await publicationTarget('dryRun', root, request);
  const plan = await planPublication(target);

  return {
    kind: target.kind,
    token: publicationToken(plan.target, plan.files),
    findings: plan.findings,
  };
};

// Refuses unless every file still matches the token, then runs one gh command.
export const publishPublication = async (
  runtime: CommandRuntime,
  root: string,
  request: PublishRequest,
): Promise<PublishResult> => {
  const target = await publicationTarget('publish', root, request);
  const token = requireValue('publish', 'token from dryRun', request.token);
  const plan = await planPublication(target);

  const decision = decidePublication({ token, target: plan.target, files: plan.files });

  if (decision.kind === 'refuse') {
    throw new Error(decision.reason);
  }

  const stdout = await runWithVerifiedBytes(runtime, plan.commandArguments, plan.fileArguments);
  const url = publishedUrl(target.kind, plan.target.repository, stdout);

  return { kind: target.kind, files: plan.files.map((file) => file.file), url };
};
