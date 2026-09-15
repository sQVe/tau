import { chmod, lstat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { DiagnosticFile, RunDiagnostics, SpawnResult } from './types.js';
import { maximumReportBytes, maximumStdoutBytes, maximumTotalBytes } from './types.js';

const saveOutput = async (
  path: string,
  text: string,
  limit: number,
  observedBytes = Buffer.byteLength(text),
  captureTruncated = false,
): Promise<DiagnosticFile> => {
  const decoded = Buffer.from(text);
  // Do not flush the decoder: a partial UTF-8 character at the boundary must be omitted.
  const content = new StringDecoder('utf8').write(decoded.subarray(0, limit));
  const savedBytes = Buffer.byteLength(content);

  await writeFile(path, content, { mode: 0o600, flag: 'wx' });

  return {
    path,
    bytes: observedBytes,
    decodedBytes: decoded.length,
    savedBytes,
    truncated: captureTruncated || decoded.length > savedBytes || observedBytes > decoded.length,
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
  const errors: string[] = [];
  const retain = async (save: () => Promise<DiagnosticFile | undefined>) => {
    try {
      return await save();
    } catch (error) {
      // One unavailable artifact must not discard other diagnostics or the test outcome.
      errors.push(String(error));

      return undefined;
    }
  };

  diagnostics.report = await retain(() => retainReport(diagnostics.directory));

  if (result !== undefined) {
    diagnostics.excerpt = (result.stderr || result.stdout).slice(0, 800);
    diagnostics.stdout = await retain(() =>
      saveOutput(
        join(diagnostics.directory, 'stdout.txt'),
        result.stdout,
        maximumStdoutBytes,
        result.stdoutBytes,
        result.stdoutTruncated,
      ),
    );
    diagnostics.stderr = await retain(() =>
      saveOutput(
        join(diagnostics.directory, 'stderr.txt'),
        result.stderr,
        maximumTotalBytes,
        result.stderrBytes,
      ),
    );
  }

  if (errors.length > 0) {
    diagnostics.error = `Could not save all diagnostics:\n${errors.join('\n')}`;
  }

  return diagnostics;
};
