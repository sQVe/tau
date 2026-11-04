import { chmod, lstat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { isMissingFile } from '../../../errors.js';
import { reportLabels } from './constants.js';
import { maximumStdoutBytes, maximumTotalBytes } from './process.js';
import type {
  DiagnosticFile,
  PackageResolutionDiagnostic,
  ReportFormat,
  ReportTarget,
  RunDiagnostics,
  RunStage,
  SpawnResult,
} from './types.js';

interface OutputCapture {
  observedBytes: number;
  truncated: boolean;
}

export interface RunOverview {
  directory: string;
  durationMs: number;
  timeoutMs: number;
  report: ReportTarget;
  resolution?: PackageResolutionDiagnostic;
}

export interface StageSpawn {
  name: string;
  durationMs: number;
  result: SpawnResult;
}

const bytesPerMebibyte = 1_048_576;
const maximumReportMebibytes = 8;
const maximumReportBytes = maximumReportMebibytes * bytesPerMebibyte;
const maximumExcerptLength = 800;
const ownerReadWriteMode = 0o600;

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

const retainReport = async (
  path: string,
  format: ReportFormat,
): Promise<DiagnosticFile | undefined> => {
  let bytes: number;

  try {
    const metadata = await lstat(path);

    if (!metadata.isFile()) {
      throw new Error(`The ${reportLabels[format]} is not a regular file.`);
    }

    bytes = metadata.size;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }

  await chmod(path, ownerReadWriteMode);

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

const retain = async (
  errors: string[],
  save: () => Promise<DiagnosticFile | undefined>,
): Promise<DiagnosticFile | undefined> => {
  try {
    return await save();
  } catch (error) {
    // One unavailable artifact must not discard other diagnostics or the test outcome.
    errors.push(String(error));

    return undefined;
  }
};

const saveStage = async (
  directory: string,
  stage: StageSpawn,
  errors: string[],
  labelFiles: boolean,
): Promise<RunStage> => {
  const { result } = stage;
  const prefix = labelFiles ? `${stage.name}.` : '';

  const stdout = await retain(errors, () =>
    saveOutput(join(directory, `${prefix}stdout.txt`), result.stdout, maximumStdoutBytes, {
      observedBytes: result.stdoutBytes,
      truncated: result.stdoutTruncated,
    }),
  );

  const stderr = await retain(errors, () =>
    saveOutput(join(directory, `${prefix}stderr.txt`), result.stderr, maximumTotalBytes, {
      observedBytes: result.stderrBytes,
      truncated: false,
    }),
  );

  return {
    name: stage.name,
    command: result.command,
    started: result.started,
    exitCode: result.code,
    durationMs: stage.durationMs,
    stdout,
    stderr,
    excerpt: (result.stderr || result.stdout).slice(0, maximumExcerptLength),
  };
};

export const saveDiagnostics = async (
  run: RunOverview,
  stages: StageSpawn[],
): Promise<RunDiagnostics> => {
  const errors: string[] = [];
  const labelFiles = stages.length > 1;

  const report = await retain(errors, () => retainReport(run.report.path, run.report.format));

  const savedStages = await Promise.all(
    stages.map((stage) => saveStage(run.directory, stage, errors, labelFiles)),
  );

  const diagnostics: RunDiagnostics = {
    ...run,
    report: { ...run.report, file: report },
    stages: savedStages,
  };

  if (errors.length > 0) {
    diagnostics.error = `Could not save all diagnostics:\n${errors.join('\n')}`;
  }

  return diagnostics;
};
