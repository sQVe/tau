import { posix } from 'node:path';

const leavesDirectory = (path: string) => path === '..' || path.startsWith('../');

// Returns the chosen Cargo project's directory relative to the session directory, only when the
// project lies in the checkout but outside the session.
export const projectDirectoryFromSession = (
  cwd: string,
  repositoryRoot: string,
  cargoManifestPath: string | undefined,
): string | undefined => {
  if (cargoManifestPath === undefined) {
    return undefined;
  }

  const directory = posix.dirname(posix.resolve(repositoryRoot, cargoManifestPath));
  const fromSession = posix.relative(cwd, directory);

  if (!leavesDirectory(fromSession) || leavesDirectory(posix.relative(repositoryRoot, directory))) {
    return undefined;
  }

  return fromSession;
};

// Returns the path the globs classify for a session-relative path, or null for a path that leaves
// the session without entering the project. Project paths classify as seen from the project.
export const classificationPath = (
  cwd: string,
  path: string,
  projectDirectory: string | undefined,
): string | null => {
  if (!leavesDirectory(path)) {
    return path;
  }

  if (projectDirectory === undefined) {
    return null;
  }

  // Both paths are relative to the session, so resolve them from it, not from the process.
  const fromProject = posix.relative(
    posix.resolve(cwd, projectDirectory),
    posix.resolve(cwd, path),
  );

  return fromProject === '' || leavesDirectory(fromProject) ? null : fromProject;
};
