import { Type } from 'typebox';

import type { CommandRuntime } from '../command.js';
import { readChecked } from './github.js';
import { formatRepository, parseRemoteUrl } from './repositoryTargetDecisions.js';

export interface MergedPullRequest {
  repository: string;
  number: number;
  url: string;
  headBranch: string;
  createdAt: string;
  mergedAt: string;
}

const mergedSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  headRefName: Type.String({ minLength: 1 }),
  createdAt: Type.String({ minLength: 1 }),
  mergedAt: Type.String({ minLength: 1 }),
});

const repositoryOfPullRequestUrl = (url: string): string | undefined => {
  const location = parseRemoteUrl(url);

  if (location === undefined) {
    return undefined;
  }

  const [owner = '', name = '', pull, number, ...rest] = location.path.split('/');

  const hasPullPath = pull === 'pull' && /^\d+$/u.test(number ?? '');
  const hasNoExtraSegments = rest.length === 0;

  if (!hasPullPath || !hasNoExtraSegments) {
    return undefined;
  }

  return formatRepository({ host: location.host, owner, name });
};

export const readMergedPullRequest = async (
  runtime: CommandRuntime,
  url: string,
): Promise<MergedPullRequest | undefined> => {
  const repository = repositoryOfPullRequestUrl(url);

  if (repository === undefined) {
    return undefined;
  }

  try {
    const value = await readChecked(
      runtime,
      ['pr', 'view', url, '--json', 'number,headRefName,createdAt,mergedAt'],
      mergedSchema,
    );

    return {
      repository,
      number: value.number,
      url,
      headBranch: value.headRefName,
      createdAt: value.createdAt,
      mergedAt: value.mergedAt,
    };
  } catch {
    return undefined;
  }
};
