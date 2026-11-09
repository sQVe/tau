import { expect, it } from 'vitest';

import { cargoInputFiles } from './cargoInputFiles.js';

const besideManifest = (directory: string): string[] =>
  [
    'Cargo.toml',
    'Cargo.lock',
    'build.rs',
    '.cargo/config',
    '.cargo/config.toml',
    '.config/nextest.toml',
    'rust-toolchain',
    'rust-toolchain.toml',
  ].map((file) => `${directory}/${file}`);

const workspaceFiles = (directory: string): string[] => [
  `${directory}/Cargo.lock`,
  `${directory}/Cargo.toml`,
];

it.for<{
  name: string;
  manifestPath: string | undefined;
  cwd: string;
  root: string;
  expected: string[];
}>([
  {
    name: 'adds nothing for a session at the root without a manifest',
    manifestPath: undefined,
    cwd: '/repo',
    root: '/repo',
    expected: [],
  },
  {
    name: 'adds the workspace files of each directory above a member session up to the root',
    manifestPath: undefined,
    cwd: '/repo/backend/member',
    root: '/repo',
    expected: [...workspaceFiles('/repo/backend'), ...workspaceFiles('/repo')],
  },
  {
    name: 'adds nothing above a session outside the root',
    manifestPath: undefined,
    cwd: '/elsewhere/member',
    root: '/repo',
    expected: [],
  },
  {
    name: 'adds nothing above a session in a sibling whose name starts with the root name',
    manifestPath: undefined,
    cwd: '/repo-other/member',
    root: '/repo',
    expected: [],
  },
  {
    name: 'adds the files beside a manifest at the root and nothing above it',
    manifestPath: '/repo/Cargo.toml',
    cwd: '/repo/sub',
    root: '/repo',
    expected: besideManifest('/repo'),
  },
  {
    name: 'adds the files beside a member manifest and the workspace files above it',
    manifestPath: '/repo/backend/member/Cargo.toml',
    cwd: '/repo',
    root: '/repo',
    expected: [
      ...besideManifest('/repo/backend/member'),
      ...workspaceFiles('/repo/backend'),
      ...workspaceFiles('/repo'),
    ],
  },
  {
    name: 'adds only the files beside a manifest outside the root',
    manifestPath: '/outside/member/Cargo.toml',
    cwd: '/repo',
    root: '/repo',
    expected: besideManifest('/outside/member'),
  },
  {
    name: 'ignores the session directory when a manifest is chosen',
    manifestPath: '/repo/backend/Cargo.toml',
    cwd: '/repo/a/b',
    root: '/repo',
    expected: [...besideManifest('/repo/backend'), ...workspaceFiles('/repo')],
  },
])('$name', ({ manifestPath, cwd, root, expected }) => {
  expect(cargoInputFiles(manifestPath, cwd, root)).toEqual(expected);
});
