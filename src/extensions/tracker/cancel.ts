import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { confirmWithUser } from '../../dialog/dialog.js';
import { errorMessage } from '../../errors.js';
import { isPullRequestUrl, readPullRequestState } from '../../github/github.js';
import { run } from '../../linear/linear.js';
import { isWorkerProcess } from '../../worker.js';
import { decideCancel, decideConfirmedCancel } from './cancelDecision.js';
import type { PullRequestEvidence } from './cancelDecision.js';
import { readCancellation } from './linear.js';

export interface CancelDetails {
  status: 'canceled' | 'unchanged' | 'declined';
  identifier: string;
}

const readPullRequests = async (exec: Exec, context: ExtensionContext, urls: string[]) => {
  const runtime = { exec, cwd: context.cwd, signal: undefined };

  return Promise.all(
    urls.filter(isPullRequestUrl).map(async (url): Promise<PullRequestEvidence> => {
      try {
        return { url, state: await readPullRequestState(runtime, url) };
      } catch (error) {
        return { url, error: errorMessage(error) };
      }
    }),
  );
};

const readGuardedCancellation = async (exec: Exec, context: ExtensionContext, ticket: string) => {
  const issue = await readCancellation(exec, context.cwd, ticket);
  const urls = issue.attachments.nodes.map((attachment) => attachment.url);
  const pullRequests = await readPullRequests(exec, context, urls);
  const decision = decideCancel(issue.state.type, pullRequests);
  const identifier = issue.identifier;

  if (decision.kind === 'refuse') {
    throw new Error(`Cannot cancel ${identifier}: ${decision.reason} Nothing was written.`);
  }

  return { issue, decision };
};

export const cancel = async (
  exec: Exec,
  context: ExtensionContext,
  ticket: string,
): Promise<CancelDetails> => {
  const { issue, decision } = await readGuardedCancellation(exec, context, ticket);
  const identifier = issue.identifier;

  if (decision.kind === 'unchanged') {
    return { status: 'unchanged', identifier };
  }

  if (!context.hasUI || isWorkerProcess()) {
    return { status: 'declined', identifier };
  }

  const approved = await confirmWithUser(context, {
    action: 'Canceling a ticket',
    title: `Cancel ${identifier} in Linear`,
    message: `${identifier}: ${issue.title}\nCurrent state: ${issue.state.name}\nNew state: canceled`,
  });

  if (!approved) {
    return { status: 'declined', identifier };
  }

  const current = await readGuardedCancellation(exec, context, ticket);

  if (current.decision.kind === 'unchanged') {
    return { status: 'unchanged', identifier: current.issue.identifier };
  }

  const confirmed = decideConfirmedCancel(issue, current.issue);

  if (confirmed.kind === 'refuse') {
    throw new Error(`Cannot cancel ${identifier}: ${confirmed.reason} Nothing was written.`);
  }

  await run(exec, context.cwd, ['issue', 'update', ticket, '--state', 'canceled', '--no-input']);

  return { status: 'canceled', identifier };
};
