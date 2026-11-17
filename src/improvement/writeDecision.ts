import { isAbsolute, relative, sep } from 'node:path';

const escapesRoot = (relativePath: string) =>
  relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

export const isWriteWithinRoot = (target: string, root: string | undefined): boolean => {
  if (root === undefined || root === '') {
    return true;
  }

  if (!isAbsolute(target) || !isAbsolute(root)) {
    return false;
  }

  return !escapesRoot(relative(root, target));
};
