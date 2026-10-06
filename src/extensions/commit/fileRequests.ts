export interface FileRequest {
  file: string;
  exists: boolean;
  indexed: boolean;
  staged: boolean;
}

export const unknownPaths = (requests: FileRequest[]): string[] =>
  requests
    .filter(({ exists, indexed, staged }) => !exists && !indexed && !staged)
    .map(({ file }) => file);
