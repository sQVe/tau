import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const besideManifestFiles = [
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  '.cargo/config',
  '.cargo/config.toml',
  '.config/nextest.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
];

// A workspace keeps its Cargo.toml and Cargo.lock at the workspace root, any ancestor of a member.
const workspaceFiles = ['Cargo.lock', 'Cargo.toml'];

const isInside = (root: string, directory: string): boolean => {
  const path = relative(root, directory);

  return path.split(sep)[0] !== '..' && !isAbsolute(path);
};

const ancestorFiles = (directory: string, repositoryRoot: string): string[] => {
  const files: string[] = [];
  let current = directory;

  while (current !== repositoryRoot && isInside(repositoryRoot, current)) {
    const parent = dirname(current);

    files.push(...workspaceFiles.map((file) => join(parent, file)));
    current = parent;
  }

  return files;
};

// The configuration globs cover only the session directory, so the files above it, or beside and
// above a chosen manifest, are added by absolute path, present or not.
export const cargoInputFiles = (
  manifestPath: string | undefined,
  cwd: string,
  repositoryRoot: string,
): string[] => {
  if (manifestPath === undefined) {
    return ancestorFiles(cwd, repositoryRoot);
  }

  const directory = dirname(manifestPath);

  return [
    ...besideManifestFiles.map((file) => join(directory, file)),
    ...ancestorFiles(directory, repositoryRoot),
  ];
};
