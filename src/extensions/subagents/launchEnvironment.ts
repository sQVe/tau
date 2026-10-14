export interface LaunchEnvironment {
  profile: string;
  worktree: string;
  worktreeExists: boolean;
  url: { address: string; answers: boolean } | undefined;
}

const checkedProfiles = new Set(['qa', 'browser']);

export const checksLaunchEnvironment = (profile: string): boolean => checkedProfiles.has(profile);

const isHttpUrl = (url: string): boolean => {
  if (!URL.canParse(url)) {
    return false;
  }

  const { protocol } = new URL(url);

  return protocol === 'http:' || protocol === 'https:';
};

export const appUrlRefusal = (profile: string, url: string | undefined): string | undefined => {
  if (url === undefined) {
    return undefined;
  }

  if (!checksLaunchEnvironment(profile)) {
    return 'url applies only to the qa and browser profiles.';
  }

  if (!isHttpUrl(url)) {
    return 'url must be an http or https URL, such as http://localhost:3000.';
  }

  return undefined;
};

export const launchEnvironmentRefusal = ({
  profile,
  worktree,
  worktreeExists,
  url,
}: LaunchEnvironment): string | undefined => {
  if (!checksLaunchEnvironment(profile)) {
    return undefined;
  }

  if (!worktreeExists) {
    return `Launch refused: no worktree at ${worktree}.`;
  }

  if (url !== undefined && !url.answers) {
    return `Launch refused: no server at ${url.address}. Start the app, then launch again.`;
  }

  return undefined;
};

export const briefWithAppUrl = (brief: string, url: string | undefined): string =>
  url === undefined ? brief : `${brief}\n\nApp URL: ${url}`;

// Counts code points, as the saved task schema does.
export const briefLimitRefusal = (brief: string, limit: number): string | undefined =>
  Array.from(brief).length > limit
    ? `The task with its App URL line exceeds ${limit} characters. Shorten the task.`
    : undefined;
