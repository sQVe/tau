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
