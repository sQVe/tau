// Decides which profile packages a worker loads with -e, from the sources the caller read.
// tests/structure.test.ts keeps this module pure.

// Pi treats every other source as a local path.
const remotePrefixes = ['npm:', 'git:', 'github:', 'http:', 'https:', 'ssh:'];

export const isLocalPackage = (source: string): boolean =>
  !remotePrefixes.some((prefix) => source.trim().startsWith(prefix));

const npmName = (spec: string): string =>
  spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/)?.[1] ?? spec;

const hostedDomains: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

const isDomain = (host: string): boolean =>
  host.includes('.') || host.toLowerCase() === 'localhost';

// Pi reads `git:user/repo` as GitHub, and `git:github:user/repo` as that host.
const hostedLocation = (url: string): { host: string; path: string } | undefined => {
  const prefixed = url.match(/^([a-z]+):([^/]+\/[^/]+)$/);
  const domain = prefixed ? hostedDomains[prefixed[1] ?? ''] : undefined;

  if (domain !== undefined) {
    return { host: domain, path: prefixed?.[2] ?? '' };
  }

  const [owner = '', ...rest] = url.split('/');

  return !isDomain(owner) && rest.length === 1 ? { host: 'github.com', path: url } : undefined;
};

const gitLocation = (url: string): { host: string; path: string } | undefined => {
  const hosted = hostedLocation(url);

  if (hosted) {
    return hosted;
  }

  const scpLike = url.match(/^git@([^:]+):(.+)$/);

  if (scpLike) {
    return { host: scpLike[1] ?? '', path: scpLike[2] ?? '' };
  }

  if (/^(?:https?|ssh|git):\/\//i.test(url)) {
    try {
      const parsed = new URL(url);

      return { host: parsed.hostname, path: parsed.pathname };
    } catch {
      return undefined;
    }
  }

  const slash = url.indexOf('/');
  const host = url.slice(0, slash);

  // Pi reads a shorthand without a domain as a local path.
  if (slash === -1 || !isDomain(host)) {
    return undefined;
  }

  return { host, path: url.slice(slash + 1) };
};

// Pi takes a ref after `@` in the path or after `#`, and ignores a `.git` suffix.
const gitIdentity = (source: string): string | undefined => {
  const trimmed = source.trim();
  const prefixed = trimmed.startsWith('git:');
  const url = (prefixed ? trimmed.slice(4) : trimmed).trim().split('#')[0] ?? '';

  if (!prefixed && !/^(?:https?|ssh|git):\/\//i.test(url)) {
    return undefined;
  }

  const location = gitLocation(url);

  if (location === undefined) {
    return undefined;
  }

  const [path = ''] = location.path.replace(/^\/+/, '').split('@');
  const repository = path.replace(/\.git$/, '');

  if (!location.host || !repository) {
    return undefined;
  }

  return `git:${location.host.toLowerCase()}/${repository}`;
};

// npm packages match by name and git packages by host and path, as in Pi's settings. The caller
// passes local sources as absolute paths.
const packageIdentity = (source: string): string => {
  // Pi reads ` npm:name` with a leading space as a path, not an npm package.
  if (source.startsWith('npm:')) {
    return `npm:${npmName(source.slice(4).trim())}`;
  }

  const trimmed = source.trim();

  if (isLocalPackage(trimmed)) {
    return `local:${trimmed}`;
  }

  return gitIdentity(trimmed) ?? `source:${trimmed}`;
};

// A package already in the user's or project's settings loads there, and a profile's first entry for
// a package wins. A second copy from -e would register the same tools twice.
export const packagesToLoad = (
  profilePackages: readonly string[],
  configuredPackages: readonly string[],
): string[] => {
  const loaded = new Set(configuredPackages.map((source) => packageIdentity(source)));
  const load: string[] = [];

  for (const source of profilePackages) {
    const identity = packageIdentity(source);

    if (!loaded.has(identity)) {
      loaded.add(identity);
      load.push(source);
    }
  }

  return load;
};
