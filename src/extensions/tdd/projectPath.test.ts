import { expect, it } from 'vitest';

import { classificationPath, projectDirectoryFromSession } from './projectPath.js';

it.for<{
  name: string;
  cwd: string;
  manifest: string | undefined;
  expected: string | undefined;
}>([
  { name: 'no manifest', cwd: '/repo/tools', manifest: undefined, expected: undefined },
  {
    name: 'a manifest in the session',
    cwd: '/repo',
    manifest: 'backend/Cargo.toml',
    expected: undefined,
  },
  {
    name: 'a manifest at the session',
    cwd: '/repo/backend',
    manifest: 'backend/Cargo.toml',
    expected: undefined,
  },
  {
    name: 'a sibling manifest',
    cwd: '/repo/tools',
    manifest: 'backend/Cargo.toml',
    expected: '../backend',
  },
  {
    name: 'a manifest above the session',
    cwd: '/repo/tools/sub',
    manifest: 'Cargo.toml',
    expected: '../..',
  },
  {
    name: 'a manifest outside the checkout',
    cwd: '/repo',
    manifest: '../outside/Cargo.toml',
    expected: undefined,
  },
])('finds the project directory outside the session for $name', ({ cwd, manifest, expected }) => {
  expect(projectDirectoryFromSession(cwd, '/repo', manifest)).toBe(expected);
});

it.for<{ name: string; path: string; project: string | undefined; expected: string | null }>([
  {
    name: 'a session path without a project',
    path: 'src/lib.rs',
    project: undefined,
    expected: 'src/lib.rs',
  },
  {
    name: 'a session path with a project',
    path: 'src/lib.rs',
    project: '../backend',
    expected: 'src/lib.rs',
  },
  {
    name: 'a path above the session without a project',
    path: '../backend/src/lib.rs',
    project: undefined,
    expected: null,
  },
  {
    name: 'a path in the project',
    path: '../backend/src/lib.rs',
    project: '../backend',
    expected: 'src/lib.rs',
  },
  {
    name: 'a path beside the project',
    path: '../frontend/src/lib.rs',
    project: '../backend',
    expected: null,
  },
  {
    name: 'a sibling whose name starts with the project name',
    path: '../backend-old/src/lib.rs',
    project: '../backend',
    expected: null,
  },
  {
    name: 'the project directory itself',
    path: '../backend',
    project: '../backend',
    expected: null,
  },
  {
    name: 'a path above the project',
    path: '../../x/src/lib.rs',
    project: '../backend',
    expected: null,
  },
  { name: 'the session parent', path: '..', project: '../backend', expected: null },
  {
    name: 'a path in a project above the session',
    path: '../src/lib.rs',
    project: '../..',
    expected: 'tools/src/lib.rs',
  },
])('classifies $name', ({ path, project, expected }) => {
  expect(classificationPath('/repo/tools/sub', path, project)).toBe(expected);
});
