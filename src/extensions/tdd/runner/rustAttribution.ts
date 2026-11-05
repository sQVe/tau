import type { TestAttribution } from './types.js';

export interface RustBinarySources {
  binaryId: string;
  sources: string[] | null;
  testNames: string[];
}

interface RustResultFacts {
  binaryId: string;
  fullname: string;
}

export interface AttributionRequest {
  result: RustResultFacts;
  binaries: RustBinarySources[];
  requestedFiles: string[];
}

export type RustAttribution = { kind: 'exact'; file: string } | TestAttribution;

const requestedInBinary = (binary: RustBinarySources, requestedFiles: string[]): string[] => [
  ...new Set((binary.sources ?? []).filter((source) => requestedFiles.includes(source))),
];

export const attributeRustResult = (request: AttributionRequest): RustAttribution => {
  const { result, binaries, requestedFiles } = request;
  const own = binaries.find((binary) => binary.binaryId === result.binaryId);

  if (own === undefined) {
    return { kind: 'unknown', reason: `no binary named ${result.binaryId}` };
  }

  if (own.sources === null) {
    return { kind: 'unknown', reason: `no dep-info for binary ${own.binaryId}` };
  }

  const matching = requestedInBinary(own, requestedFiles);

  if (matching.length === 0) {
    return {
      kind: 'unknown',
      reason: `binary ${own.binaryId} lists no requested file for ${result.fullname}`,
    };
  }

  const duplicates = binaries
    .filter((binary) => binary.binaryId !== own.binaryId)
    .filter((binary) => binary.testNames.includes(result.fullname))
    .map((binary) => binary.binaryId);

  const binaryIds = [own.binaryId, ...duplicates];

  if (matching.length > 1) {
    return { kind: 'ambiguous', binaryIds, files: matching };
  }

  if (duplicates.length > 0) {
    return { kind: 'ambiguous', binaryIds };
  }

  return { kind: 'exact', file: matching[0] ?? '' };
};
