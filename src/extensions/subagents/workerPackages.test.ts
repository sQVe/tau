import { expect, it } from 'vitest';

import { packagesToLoad } from './workerPackages.js';

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
