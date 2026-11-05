import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { CargoMetadata } from './cargoMetadata.js';
import type { NextestBinary } from './nextestList.js';
import type { RustBinarySources } from './rustAttribution.js';
import { parseRustDepInfo } from './rustDepInfo.js';

const readDepInfoSources = async (binaryPath: string): Promise<string[] | null> => {
  try {
    return parseRustDepInfo(await readFile(`${binaryPath}.d`, 'utf8'));
  } catch {
    return null;
  }
};

const toCwdRelative = (cwd: string, workspaceRoot: string, file: string): string =>
  relative(cwd, resolve(workspaceRoot, file));

const depInfoSourcesFor = async (
  cwd: string,
  workspaceRoot: string,
  binary: NextestBinary,
): Promise<string[] | null> => {
  const depInfo = await readDepInfoSources(binary.binaryPath);

  return depInfo === null ? null : depInfo.map((file) => toCwdRelative(cwd, workspaceRoot, file));
};

export const buildBinarySources = async (
  cwd: string,
  metadata: CargoMetadata,
  binaries: NextestBinary[],
): Promise<RustBinarySources[]> => {
  const depInfo = await Promise.all(
    binaries.map((binary) => depInfoSourcesFor(cwd, metadata.workspaceRoot, binary)),
  );

  return binaries.map((binary, index) => ({
    binaryId: binary.binaryId,
    sources: depInfo[index] ?? null,
    testNames: binary.testNames,
  }));
};
