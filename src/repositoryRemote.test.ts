import { expect, it } from 'vitest';

import { repositoryFromRemote } from './repositoryRemote.js';

it.each([
  { url: 'git@github.com:sQVe/tau.git', repository: 'sQVe/tau' },
  { url: 'git@github.com:sQVe/tau', repository: 'sQVe/tau' },
  { url: 'github.com:sQVe/tau.git', repository: 'sQVe/tau' },
  { url: 'ssh://git@github.com/sQVe/tau.git', repository: 'sQVe/tau' },
  { url: 'ssh://git@github.com:22/sQVe/tau', repository: 'sQVe/tau' },
  { url: 'https://github.com/sQVe/tau.git', repository: 'sQVe/tau' },
  { url: 'https://github.com/sQVe/tau/', repository: 'sQVe/tau' },
  { url: 'https://user:token@github.com/sQVe/tau.git\n', repository: 'sQVe/tau' },
  { url: 'https://github.com/sQVe/tau.js', repository: 'sQVe/tau.js' },
  { url: 'https://github.com/sQVe/my.github.io', repository: 'sQVe/my.github.io' },
  { url: 'https://github.com/sQVe/tau.github', repository: 'sQVe/tau.github' },
  { url: 'https://github.com/sQVe/tau.git.git', repository: 'sQVe/tau.git' },
  { url: 'https://github.com:bad/sQVe/tau', repository: undefined },
  { url: 'see https://github.com/sQVe/tau', repository: undefined },
  { url: '/srv/mirror/host:sQVe/tau', repository: undefined },
  { url: 'https://gitlab.com/group/subgroup/tau.git', repository: undefined },
  { url: 'https://github.com/sQVe', repository: undefined },
  { url: 'file:///srv/sQVe/tau.git', repository: undefined },
  { url: '/srv/sQVe/tau.git', repository: undefined },
  { url: '../tau', repository: undefined },
  { url: 'git@github.com:sQVe/ta u.git', repository: undefined },
  { url: 'https://github.com/sQVe/%0Atau', repository: undefined },
  { url: '', repository: undefined },
])('reads $repository from the remote URL $url', ({ url, repository }) => {
  expect(repositoryFromRemote(url)).toBe(repository);
});
