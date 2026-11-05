import { isRecord } from '../../../schema.js';

export interface NextestBinary {
  binaryId: string;
  binaryName: string;
  kind: string;
  binaryPath: string;
  packageId: string;
  cwd: string;
  testNames: string[];
}

export interface NextestList {
  binaries: NextestBinary[];
}

const textField = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];

  return typeof value === 'string' && value !== '' ? value : null;
};

const binaryOf = (suite: unknown): NextestBinary | null => {
  if (!isRecord(suite) || !isRecord(suite['testcases'])) {
    return null;
  }

  const binaryId = textField(suite, 'binary-id');
  const binaryName = textField(suite, 'binary-name');
  const kind = textField(suite, 'kind');
  const binaryPath = textField(suite, 'binary-path');
  const packageId = textField(suite, 'package-id');
  const cwd = textField(suite, 'cwd');

  if (binaryId === null || binaryName === null || kind === null) {
    return null;
  }

  if (binaryPath === null || packageId === null || cwd === null) {
    return null;
  }

  return {
    binaryId,
    binaryName,
    kind,
    binaryPath,
    packageId,
    cwd,
    testNames: Object.keys(suite['testcases']),
  };
};

export const parseNextestList = (stdout: string): NextestList | null => {
  let document: unknown;

  try {
    document = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!isRecord(document) || !isRecord(document['rust-suites'])) {
    return null;
  }

  const binaries: NextestBinary[] = [];

  for (const suite of Object.values(document['rust-suites'])) {
    const binary = binaryOf(suite);

    if (binary === null) {
      return null;
    }

    binaries.push(binary);
  }

  return { binaries };
};
