export interface LaunchEnvironment {
  profile: string;
  worktree: string;
  worktreeExists: boolean;
  url: { address: string; answers: boolean } | undefined;
}

const checkedProfiles = new Set(['qa', 'browser']);

export const checksLaunchEnvironment = (profile: string): boolean => checkedProfiles.has(profile);

export const isHttpUrl = (url: string): boolean => {
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

const appUrlPrefix = 'App URL:';

const appUrlValue = (line: string): string | undefined => {
  const trimmed = line.trimStart();

  if (!trimmed.startsWith(appUrlPrefix)) {
    return undefined;
  }

  const value = trimmed.slice(appUrlPrefix.length).trim();

  return value === '' ? undefined : value;
};

const appUrlLine = (url: string): string => `${appUrlPrefix} ${url.trim()}`;

export const hasAppUrlLine = (task: string): boolean =>
  task.split('\n').some((line) => {
    const value = appUrlValue(line);

    return value !== undefined && isHttpUrl(value);
  });

export const briefWithAppUrl = (brief: string, url: string | undefined): string =>
  url === undefined ? brief : `${brief}\n\n${appUrlLine(url)}`;

// Counts code points, as the saved task schema does.
export const briefLimitRefusal = (brief: string, limit: number): string | undefined =>
  Array.from(brief).length > limit
    ? `The task with its App URL line exceeds ${limit} characters. Shorten the task.`
    : undefined;
