import { chmod, lstat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { isMissingFile } from '../../../errors/index.js';
import { maximumStdoutBytes, maximumTotalBytes } from './process.js';
import type { DiagnosticFile, RunDiagnostics, SpawnResult } from './types.js';

const maximumReportBytes = 8 * 1024 * 1024;

interface OutputCapture {
  observedBytes: number;
  truncated: boolean;
}

const saveOutput = async (
  path: string,
  text: string,
  limit: number,
  capture: OutputCapture,
): Promise<DiagnosticFile> => {
  const decoded = Buffer.from(text);
  // Do not flush the decoder: a partial UTF-8 character at the boundary must be omitted.
  const content = new StringDecoder('utf8').write(decoded.subarray(0, limit));
  const savedBytes = Buffer.byteLength(content);

  await writeFile(path, content, { mode: 0o600, flag: 'wx' });

  return {
    path,
    bytes: capture.observedBytes,
    decodedBytes: decoded.length,
    savedBytes,
    truncated:
      capture.truncated || decoded.length > savedBytes || capture.observedBytes > decoded.length,
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
    if (isMissingFile(error)) {
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
      saveOutput(join(diagnostics.directory, 'stdout.txt'), result.stdout, maximumStdoutBytes, {
        observedBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
        truncated: result.stdoutTruncated ?? false,
      }),
    );

    diagnostics.stderr = await retain(() =>
      saveOutput(join(diagnostics.directory, 'stderr.txt'), result.stderr, maximumTotalBytes, {
        observedBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr),
        truncated: false,
      }),
    );
  }

  if (errors.length > 0) {
    diagnostics.error = `Could not save all diagnostics:\n${errors.join('\n')}`;
  }

  return diagnostics;
};
