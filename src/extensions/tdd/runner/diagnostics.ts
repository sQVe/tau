import { chmod, lstat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiagnosticFile, RunDiagnostics, SpawnResult } from './types.js';
import { maximumReportBytes, maximumStdoutBytes, maximumTotalBytes } from './types.js';

const saveOutput = async (
  path: string,
  text: string,
  limit: number,
  observedBytes = Buffer.byteLength(text),
  overflow = false,
): Promise<DiagnosticFile> => {
  const content = Buffer.from(text).subarray(0, limit);

  await writeFile(path, content, { mode: 0o600, flag: 'wx' });

  return {
    path,
    bytes: observedBytes,
    savedBytes: content.length,
    truncated: overflow || observedBytes > content.length,
  };
};

const retainReport = async (directory: string): Promise<DiagnosticFile | undefined> => {
  const path = join(directory, 'report.json');
  let bytes: number;

  try {
    const metadata = await lstat(path);

    if (!metadata.isFile()) {
      throw new Error('The JSON report is not a regular file.');
    }

    bytes = metadata.size;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }

  await chmod(path, 0o600);

  if (bytes > maximumReportBytes) {
    // Keep a raw prefix for inspection, not a parseable replacement for the runner's report.
    await truncate(path, maximumReportBytes);
  }

  return {
    path,
    bytes,
    savedBytes: Math.min(bytes, maximumReportBytes),
    truncated: bytes > maximumReportBytes,
  };
};

export const saveDiagnostics = async (
  diagnostics: RunDiagnostics,
  result: SpawnResult | undefined,
): Promise<RunDiagnostics> => {
  try {
    diagnostics.report = await retainReport(diagnostics.directory);

    if (result !== undefined) {
      diagnostics.stdout = await saveOutput(
        join(diagnostics.directory, 'stdout.txt'),
        result.stdout,
        maximumStdoutBytes,
        result.stdoutBytes,
        result.stdoutOverflow,
      );
      diagnostics.stderr = await saveOutput(
        join(diagnostics.directory, 'stderr.txt'),
        result.stderr,
        maximumTotalBytes,
        result.stderrBytes,
      );
      diagnostics.excerpt = (result.stderr || result.stdout).slice(0, 800);
    }
  } catch (error) {
    // Saving diagnostics must not discard the observed test outcome.
    diagnostics.error = `Could not save all diagnostics: ${String(error)}`;
  }

  return diagnostics;
};
