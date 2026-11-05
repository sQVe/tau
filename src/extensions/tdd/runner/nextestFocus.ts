import type { RustBinarySources } from './rustAttribution.js';

export type FocusPlan =
  | { kind: 'collect-none' }
  | { kind: 'unscoped' }
  | { kind: 'scoped'; binaryIds: string[] };

const binariesContainingFile = (binaries: RustBinarySources[], file: string): string[] =>
  binaries
    .filter((binary) => binary.sources?.includes(file) === true)
    .map((binary) => binary.binaryId);

export const planFocus = (binaries: RustBinarySources[], requestedFiles: string[]): FocusPlan => {
  const depInfoMissing = binaries.some((binary) => binary.sources === null);

  if (depInfoMissing || requestedFiles.length === 0) {
    return { kind: 'unscoped' };
  }

  const binaryIds = new Set<string>();

  for (const file of requestedFiles) {
    for (const binaryId of binariesContainingFile(binaries, file)) {
      binaryIds.add(binaryId);
    }
  }

  if (binaryIds.size === 0) {
    return { kind: 'collect-none' };
  }

  return { kind: 'scoped', binaryIds: [...binaryIds] };
};
