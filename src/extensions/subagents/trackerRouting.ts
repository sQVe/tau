import type { TrackerConfig, TrackerSetup } from './trackerConfig.js';

export interface TrackerFacts {
  setup: TrackerSetup;
  // The `origin` remote URL, or undefined when the checkout has none.
  originUrl: string | undefined;
}

// The tracker skill finds these lines by prefix, so keep the prefixes stable.
const agentTeamPrefix = 'Tracker agent team:';
const repositoryPrefix = 'Tracker repository:';
const setupPrefix = 'Tracker setup needed:';

// `git@host:owner/name`, the scp-like form Git uses for SSH remotes.
const scpLikeRemote = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/)(.+)$/u;
const remoteProtocols = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:']);
const repositorySegment = /^[\w.-]+$/u;

const remotePath = (url: string): string | undefined => {
  if (!url.includes('://')) {
    return scpLikeRemote.exec(url)?.[1];
  }

  if (!URL.canParse(url)) {
    return undefined;
  }

  const parsed = new URL(url);

  return remoteProtocols.has(parsed.protocol) ? parsed.pathname : undefined;
};

// Reads `owner/name` from an SSH or HTTPS remote URL such as `git@github.com:sQVe/tau.git`.
export const repositoryFromRemote = (url: string): string | undefined => {
  const path = remotePath(url.trim());

  if (path === undefined) {
    return undefined;
  }

  const segments = path.split('/').filter((segment) => segment !== '');
  const [owner, name] = segments;

  if (segments.length !== 2 || owner === undefined || name === undefined) {
    return undefined;
  }

  const repository = [owner, name.replace(/\.git$/u, '')];

  return repository.every((segment) => repositorySegment.test(segment))
    ? repository.join('/')
    : undefined;
};

const agentTeamLine = ({ agentTeam }: TrackerConfig): string =>
  agentTeam === undefined
    ? `${setupPrefix} tracker.agentTeam is not set.`
    : `${agentTeamPrefix} \`${agentTeam}\`.`;

// GitHub treats owner and repository names without regard to case.
const findRepository = ({ repositories }: TrackerConfig, repository: string) =>
  [...repositories].find(([key]) => key.toLowerCase() === repository.toLowerCase())?.[1];

const repositoryLine = (config: TrackerConfig, originUrl: string | undefined): string => {
  if (originUrl === undefined) {
    return `${setupPrefix} this checkout has no origin remote, so no tracker.repositories entry applies.`;
  }

  const repository = repositoryFromRemote(originUrl);

  if (repository === undefined) {
    return `${setupPrefix} the origin remote URL does not name an owner/name repository, so no tracker.repositories entry applies.`;
  }

  const entry = findRepository(config, repository);

  if (entry === undefined) {
    return `${setupPrefix} tracker.repositories has no entry for \`${repository}\`.`;
  }

  const project = entry.project === undefined ? 'no project' : `project \`${entry.project}\``;

  return `${repositoryPrefix} \`${repository}\` uses team \`${entry.team}\` and ${project}.`;
};

// Gives the manager prompt lines that name where tracker tickets go, or why Tau cannot tell.
export const trackerLines = ({ setup, originUrl }: TrackerFacts): string[] => {
  if (setup.status === 'unset') {
    return [];
  }

  if (setup.status === 'invalid') {
    const message = setup.message.replaceAll(/\s+/gu, ' ');

    return [`${setupPrefix} ${message}`];
  }

  return [agentTeamLine(setup.config), repositoryLine(setup.config, originUrl)];
};
