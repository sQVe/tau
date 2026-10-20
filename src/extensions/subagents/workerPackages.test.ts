import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished } from 'vitest';

import { isLocalPackage, packagesToLoad } from './workerPackages.js';

// Pi resolves a source it reads as local from the agent directory, and a Git source to its clone.
const piReadsAsLocal = (source: string): boolean => {
  const agentDirectory = mkdtempSync(join(tmpdir(), 'tau-source-'));

  onTestFinished(() => {
    rmSync(agentDirectory, { recursive: true, force: true });
  });

  const localPath = resolve(agentDirectory, source.trim());
  mkdirSync(localPath, { recursive: true });

  const manager = new DefaultPackageManager({
    cwd: agentDirectory,
    agentDir: agentDirectory,
    settingsManager: SettingsManager.inMemory(),
  });

  return manager.getInstalledPath(source, 'user') === localPath;
};

it.each([
  { profile: [], configured: ['npm:pi-agent-browser-native'], load: [] },
  {
    profile: ['npm:pi-agent-browser-native'],
    configured: [],
    load: ['npm:pi-agent-browser-native'],
  },
  {
    profile: ['npm:pi-agent-browser-native@0.8.2'],
    configured: ['npm:pi-agent-browser-native'],
    load: [],
  },
  { profile: ['npm:@scope/tool@2'], configured: ['npm:@scope/tool@1.0.0'], load: [] },
  { profile: ['npm:@scope/tool'], configured: ['npm:@scope/other'], load: ['npm:@scope/tool'] },
  {
    profile: ['npm:pi-codex-image-gen', 'npm:pi-agent-browser-native'],
    configured: ['npm:pi-agent-browser-native'],
    load: ['npm:pi-codex-image-gen'],
  },
  { profile: ['git:github.com/user/repo@v1'], configured: ['git:github.com/user/repo'], load: [] },
  {
    profile: ['https://github.com/user/repo.git#main'],
    configured: ['git:github.com/user/repo@v2'],
    load: [],
  },
  {
    profile: ['git:git@github.com:user/repo'],
    configured: ['ssh://git@github.com/user/repo'],
    load: [],
  },
  {
    profile: ['git:github.com/user/repo'],
    configured: ['git:gitlab.com/user/repo'],
    load: ['git:github.com/user/repo'],
  },
  {
    profile: ['git:github.com/user/repo'],
    configured: ['npm:repo'],
    load: ['git:github.com/user/repo'],
  },
  { profile: ['git:user/repo'], configured: ['git:github.com/user/repo'], load: [] },
  { profile: ['git:github:user/repo@v1'], configured: ['https://github.com/user/repo'], load: [] },
  { profile: ['git:gitlab:group/repo'], configured: ['git:gitlab.com/group/repo'], load: [] },
  { profile: ['git:bitbucket:team/repo'], configured: ['git:bitbucket.org/team/repo'], load: [] },
  {
    profile: ['git:gitlab:group/repo'],
    configured: ['git:github.com/group/repo'],
    load: ['git:gitlab:group/repo'],
  },
  {
    profile: ['git:localhost/user/repo'],
    configured: ['git:github.com/user/repo'],
    load: ['git:localhost/user/repo'],
  },
  { profile: ['npm:foo'], configured: [' npm:foo'], load: ['npm:foo'] },
  { profile: ['npm:foo', 'npm:foo@1.2.3'], configured: [], load: ['npm:foo'] },
  {
    profile: ['git:github.com/user/repo', 'https://github.com/user/repo.git'],
    configured: [],
    load: ['git:github.com/user/repo'],
  },
  { profile: ['npm:foo', 'npm:foo@1.2.3'], configured: ['npm:foo@2'], load: [] },
  { profile: ['/work/extensions/probe'], configured: ['/work/extensions/probe'], load: [] },
  {
    profile: ['/work/extensions/probe'],
    configured: ['/work/extensions/other'],
    load: ['/work/extensions/probe'],
  },
])(
  'loads $load for profile packages $profile when settings hold $configured',
  ({ profile, configured, load }) => {
    expect(packagesToLoad(profile, configured)).toEqual(load);
  },
);

it.each([
  { profile: ['git:github.com/user/repo'], configured: ['git:github.com/other/repo'] },
  { profile: ['http:a'], configured: ['http:b'] },
  { profile: ['http:a/b'], configured: ['git:github.com/http:a/b'] },
  { profile: ['git:github:user/repo/extra'], configured: ['git:github.com/user/repo'] },
  { profile: ['git:example.com'], configured: ['git:example.co/example.com'] },
  { profile: ['git:user/repo/x'], configured: ['ssh://user/repo/x'] },
  { profile: ['git:x/github:user/repo'], configured: ['git:github.com/user/repo'] },
  {
    profile: ['git:ftp://github.com/user/repo/https://x'],
    configured: ['ssh://github.com/user/repo/https://x'],
  },
  {
    profile: ['http:github.com/user/repo/https://x'],
    configured: ['git:http:github.com/user/repo/https://x'],
  },
  { profile: ['git:github.com/'], configured: ['ssh://github.com/'] },
  { profile: ['ssh:///a/b'], configured: ['ssh:///a/b#ref'] },
  { profile: ['./probe'], configured: ['./other'] },
  { profile: ['git:example.ß/user/repo'], configured: ['git:example.ss/user/repo'] },
  { profile: ['git:github.com/user/my.gitrepo'], configured: ['git:github.com/user/myrepo'] },
  {
    profile: ['https://evil.test/foo/git@github.com:user/repo'],
    configured: ['git:github.com/user/repo'],
  },
  { profile: ['https://github.com//user/repo/more'], configured: ['git:github.com/user/repo'] },
])('loads $profile when settings hold $configured', ({ profile, configured }) => {
  expect(packagesToLoad(profile, configured)).toEqual(profile);
});

it.each([
  { profile: 'http://github.com/user/repo', configured: 'https://github.com/user/repo' },
  { profile: 'git:http://github.com/user/repo', configured: 'https://github.com/user/repo' },
  { profile: 'git:github.com/user/repo', configured: ' git:github.com/user/repo ' },
  { profile: 'npm: foo', configured: 'npm:foo' },
  { profile: './probe', configured: ' ./probe ' },
  { profile: 'git: github.com/user/repo', configured: 'git:github.com/user/repo' },
  { profile: 'git:localhost/user/repo', configured: 'ssh://localhost/user/repo' },
  { profile: 'git:LOCALHOST/user/repo', configured: 'ssh://localhost/user/repo' },
  { profile: 'https://github.com//user/repo', configured: 'git:github.com/user/repo' },
])('treats $profile and $configured as one package', ({ profile, configured }) => {
  expect(packagesToLoad([profile], [configured])).toEqual([]);
});

it.each(['npm:', 'npm:@', 'https://'])('does not throw on the unusual source %s', (source) => {
  expect(packagesToLoad([source, source], [])).toEqual([source]);
});

it.each([
  'github:user/repo',
  'github:probe.ts',
  'http:x',
  'https:x',
  'ssh:x',
  'https://github.com/u/r',
  'https://github.com/u/r.git',
  'https://github.com/u/r@v1',
  'https://github.com/u/r#main',
  ' https://github.com/u/r',
  'HTTPS://github.com/u/r',
  'http://example.com/a/b/c',
  'ssh://host/a/b',
  'ssh://git@host/a/b.git',
  'https://gist.github.com/abcdef',
  'https://host/@foo/bar',
])('classifies %j as Pi does', (source) => {
  expect(isLocalPackage(source)).toBe(piReadsAsLocal(source));
});

it('keeps a malformed scheme URL remote although Pi reads it as local, as a known difference', () => {
  expect(piReadsAsLocal('https://example.com/r')).toBe(true);
  expect(isLocalPackage('https://example.com/r')).toBe(false);
});

it.each(['git:user/repo', 'git:github.com/user/repo', ' git:github.com/user/repo'])(
  'keeps the git-prefixed source %j remote',
  (source) => {
    expect(isLocalPackage(source)).toBe(false);
  },
);

it.each(['npm:name', './probe', '/abs/probe', ' npm:name'])(
  'treats %j as a local path or npm source',
  (source) => {
    expect(isLocalPackage(source)).toBe(!source.startsWith('npm:'));
  },
);
