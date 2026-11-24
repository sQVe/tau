export type FileSystemOperation = 'readdir' | 'readFile' | 'writeFile' | 'truncate';

export interface FileSystemFault {
  operation: FileSystemOperation;
  matches: (path: unknown) => boolean;
  error: () => Error;
  once?: boolean;
}

const activeFaults: FileSystemFault[] = [];

export const armFileSystemFault = (fault: FileSystemFault): void => {
  activeFaults.push(fault);
};

export const resetFileSystemFaults = (): void => {
  activeFaults.length = 0;
};

export const takeFileSystemFault = (
  operation: FileSystemOperation,
  path: unknown,
): Error | undefined => {
  const fault = activeFaults.find(
    (candidate) => candidate.operation === operation && candidate.matches(path),
  );

  if (fault === undefined) {
    return undefined;
  }

  if (fault.once === true) {
    activeFaults.splice(activeFaults.indexOf(fault), 1);
  }

  return fault.error();
};

export const pathNamed =
  (name: string) =>
  (path: unknown): boolean =>
    typeof path === 'string' && path.includes(name);
