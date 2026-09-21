import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type {
  ResolveVitestFn,
  VitestResolutionDiagnostic,
  VitestResolutionFailure,
} from './types.js';

const nodeRequire = createRequire(import.meta.url);

export const extractBinPath = (manifest: unknown): string | null => {
  if (manifest == null || typeof manifest !== 'object') {
    return null;
  }

  const binary: unknown = (manifest as { bin?: unknown }).bin;

  if (typeof binary === 'string') {
    return binary;
  }

  if (binary == null || typeof binary !== 'object') {
    return null;
  }

  const entry: unknown = (binary as { vitest?: unknown }).vitest;

  return typeof entry === 'string' ? entry : null;
};

const resolutionMessages: Record<string, string> = {
  MODULE_NOT_FOUND: 'The vitest/package.json request was not found from the lookup directory.',
  ERR_PACKAGE_PATH_NOT_EXPORTED: 'Package exports do not expose vitest/package.json.',
  ERR_INVALID_PACKAGE_CONFIG: 'Node could not parse a package manifest during Vitest resolution.',
  ERR_INVALID_PACKAGE_TARGET: 'A package export target is invalid.',
  EACCES: 'Permission denied while resolving the Vitest runner.',
  EPERM: 'The filesystem denied access while resolving the Vitest runner.',
  ENOENT: 'A resolved manifest or binary file is missing.',
  ENOTDIR: 'A resolution path contains a component that is not a directory.',
  EISDIR: 'A manifest path is a directory, not a file.',
  ELOOP: 'A resolution path contains a symbolic-link loop.',
  INVALID_BIN: 'Vitest manifest has no usable local bin entry or the binary is not a file.',
  INVALID_VERSION: 'Vitest manifest has no valid version for test-name decoding.',
};

const diagnosticPath = (path: string) => {
  const printable = stripVTControlCharacters(path).replace(/\p{Cc}/gu, ' ');

  return printable.length > 400 ? `${printable.slice(0, 394)} [cut]` : printable;
};

const resolutionErrorDetails = (error: unknown) => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const errorCode =
    typeof code === 'string' && Object.hasOwn(resolutionMessages, code) ? code : undefined;
  let errorType = 'UnknownError';

  // Never copy error.message, stack, or custom names: JSON parse errors can quote credentials.
  if (error instanceof Error) {
    errorType = ['SyntaxError', 'TypeError', 'RangeError'].includes(error.name)
      ? error.name
      : 'Error';
  }

  return { errorType, ...(errorCode === undefined ? {} : { errorCode }) };
};

const validVersion = (version: unknown): version is string =>
  typeof version === 'string' &&
  version.length <= 128 &&
  /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);

const resolutionExplanation = (
  stage: VitestResolutionDiagnostic['stage'],
  errorType: string,
  errorCode: string | undefined,
  missing: boolean,
): string => {
  if (errorCode === 'MODULE_NOT_FOUND' && !missing) {
    return 'A dependency lookup failed inside the resolver; this does not establish that Vitest is absent.';
  }

  if (errorCode !== undefined) {
    return resolutionMessages[errorCode] ?? 'Vitest runner resolution failed.';
  }

  if (errorType === 'SyntaxError' && stage === 'manifest') {
    return 'Vitest manifest is not valid JSON.';
  }

  return 'Vitest runner resolution failed.';
};

const declaresMissingRequest = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith("Cannot find module 'vitest/package.json'");

export const resolutionFailure = (
  cwd: string,
  stage: VitestResolutionDiagnostic['stage'],
  error: unknown,
  paths: { manifestPath?: string; binaryPath?: string } = {},
): VitestResolutionFailure => {
  const { errorCode, errorType } = resolutionErrorDetails(error);
  const resolution: VitestResolutionDiagnostic = {
    cwd: diagnosticPath(cwd),
    request: 'vitest/package.json',
    stage,
    errorType,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(paths.manifestPath === undefined
      ? {}
      : { manifestPath: diagnosticPath(paths.manifestPath) }),
    ...(paths.binaryPath === undefined ? {} : { binaryPath: diagnosticPath(paths.binaryPath) }),
  };
  // MODULE_NOT_FOUND can also refer to a broken export target inside an installed package.
  const missing =
    stage === 'lookup' && errorCode === 'MODULE_NOT_FOUND' && declaresMissingRequest(error);
  const explanation = resolutionExplanation(stage, errorType, errorCode, missing);

  const message = [
    `${explanation} Stage: ${stage}; ${errorType}${errorCode === undefined ? '' : ` (${errorCode})`}.`,
    'Inspect this once, then fix resolution or use the repository runner. Bash tests do not update Tau observations.',
    `Lookup directory: ${resolution.cwd}; request: ${resolution.request}`,
    ...(resolution.manifestPath === undefined ? [] : [`Manifest: ${resolution.manifestPath}`]),
    ...(resolution.binaryPath === undefined ? [] : [`Binary: ${resolution.binaryPath}`]),
  ].join('\n');

  return { kind: missing ? 'runner-missing' : 'runner-resolution-error', message, resolution };
};

const manifestVersion = (manifest: unknown): unknown =>
  manifest !== null && typeof manifest === 'object' && 'version' in manifest
    ? manifest.version
    : undefined;

const isInvalidBinEntry = (binary: string): boolean => {
  if (binary.trim().length === 0) {
    return true;
  }

  if (isAbsolute(binary)) {
    return true;
  }

  return /[\p{Cc}:?#]/u.test(binary);
};

const invalidBinError = (message: string): TypeError =>
  Object.assign(new TypeError(message), { code: 'INVALID_BIN' });

const resolveBinary = (
  cwd: string,
  manifest: unknown,
  manifestPath: string,
  paths: { manifestPath?: string; binaryPath?: string },
): VitestResolutionFailure | { path: string } => {
  const binary = extractBinPath(manifest);

  if (binary === null || isInvalidBinEntry(binary)) {
    return resolutionFailure(cwd, 'binary', invalidBinError('Invalid Vitest bin entry'), paths);
  }

  const directory = dirname(manifestPath);
  const binaryPath = resolvePath(directory, binary);
  const localPath = relative(directory, binaryPath);

  if (localPath === '..' || localPath.startsWith(`..${sep}`)) {
    return resolutionFailure(
      cwd,
      'binary',
      invalidBinError('Vitest bin leaves its package'),
      paths,
    );
  }

  paths.binaryPath = binaryPath;

  if (!statSync(binaryPath).isFile()) {
    return resolutionFailure(cwd, 'binary', invalidBinError('Vitest bin is not a file'), paths);
  }

  return { path: binaryPath };
};

export const defaultResolveVitest: ResolveVitestFn = (cwd) => {
  let stage: VitestResolutionDiagnostic['stage'] = 'lookup';
  const paths: { manifestPath?: string; binaryPath?: string } = {};

  try {
    const manifestPath = nodeRequire.resolve('vitest/package.json', { paths: [cwd] });

    paths.manifestPath = manifestPath;
    stage = 'manifest';

    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = manifestVersion(manifest);

    if (!validVersion(version)) {
      return resolutionFailure(
        cwd,
        stage,
        Object.assign(new TypeError('Invalid Vitest manifest version'), {
          code: 'INVALID_VERSION',
        }),
        paths,
      );
    }

    stage = 'binary';

    const resolved = resolveBinary(cwd, manifest, manifestPath, paths);

    if ('kind' in resolved) {
      return resolved;
    }

    return { path: resolved.path, version };
  } catch (error) {
    return resolutionFailure(cwd, stage, error, paths);
  }
};
