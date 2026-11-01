// Temporary CI diagnostics for the prReviewChain timeout investigation. This file has no product
// behavior: it records test phases, real Git subprocess traces, event-loop delay, and runner
// resources. Delete this file and its calls in tests/prReviewChain.test.ts after the evidence run.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { expect, onTestFinished, vi } from 'vitest';

interface PhaseTiming {
  test: string;
  phase: string;
  startedAt: number;
  milliseconds: number | null;
}

interface CpuUsage {
  user: number;
  system: number;
}

const eventLoopResolutionMilliseconds = 10;
const phaseTimings: PhaseTiming[] = [];
const eventLoopHistogram = monitorEventLoopDelay({ resolution: eventLoopResolutionMilliseconds });

let initialCpuUsage: CpuUsage | undefined;

// Runs in the worker process, so each worker keeps its own directory and its own trace files.
const diagnosticRoot = join(tmpdir(), 'tau-pr-review-chain-diagnostics');

const traceDirectory = join(diagnosticRoot, String(process.pid));

const currentTestName = (): string => expect.getState().currentTestName ?? 'unknown';

const toMilliseconds = (nanoseconds: number): number => nanoseconds / 1_000_000;

export const startDiagnostics = (): void => {
  mkdirSync(traceDirectory, { recursive: true });

  initialCpuUsage = process.cpuUsage();
  eventLoopHistogram.enable();
};

export const traceTestGit = (): void => {
  vi.stubEnv('GIT_TRACE2_EVENT', traceDirectory);
};

export const timePhase = async <Result>(
  phase: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  const timing: PhaseTiming = {
    test: currentTestName(),
    phase,
    startedAt: performance.now(),
    milliseconds: null,
  };

  // The record exists before the await, so a Vitest timeout still shows the active phase.
  phaseTimings.push(timing);

  try {
    return await run();
  } finally {
    timing.milliseconds = performance.now() - timing.startedAt;
  }
};

// Registers the marker that runs last, after every fixture cleanup. The returned function registers
// the marker that runs first, so the pair brackets the fixture cleanups of the current test.
export const trackCleanup = (): (() => void) => {
  const test = currentTestName();
  const marker: { startedAt?: number } = {};

  onTestFinished(() => {
    if (marker.startedAt === undefined) {
      return;
    }

    phaseTimings.push({
      test,
      phase: 'cleanup',
      startedAt: marker.startedAt,
      milliseconds: performance.now() - marker.startedAt,
    });
  });

  return () => {
    onTestFinished(() => {
      marker.startedAt = performance.now();
    });
  };
};

const eventLoopDelay = () => ({
  resolutionMilliseconds: eventLoopResolutionMilliseconds,
  meanMilliseconds: toMilliseconds(eventLoopHistogram.mean),
  p50Milliseconds: toMilliseconds(eventLoopHistogram.percentile(50)),
  p99Milliseconds: toMilliseconds(eventLoopHistogram.percentile(99)),
  maxMilliseconds: toMilliseconds(eventLoopHistogram.max),
});

const runnerResources = () => {
  const finalCpuUsage = process.cpuUsage();
  const user = finalCpuUsage.user - (initialCpuUsage?.user ?? 0);
  const system = finalCpuUsage.system - (initialCpuUsage?.system ?? 0);

  return {
    cpuCount: cpus().length,
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    loadAverage: loadavg(),
    diagnosticCpuUserMicroseconds: user,
    diagnosticCpuSystemMicroseconds: system,
  };
};

const traceFileCount = (): number | null => {
  try {
    return readdirSync(traceDirectory).length;
  } catch {
    return null;
  }
};

export const printDiagnostics = (): void => {
  eventLoopHistogram.disable();

  const payload = {
    phases: phaseTimings.map((timing) => ({
      test: timing.test,
      phase: timing.phase,
      // An unfinished phase keeps the elapsed time from its start until this snapshot.
      milliseconds: timing.milliseconds ?? performance.now() - timing.startedAt,
      unfinished: timing.milliseconds === null,
    })),
    eventLoopDelay: eventLoopDelay(),
    runnerResources: runnerResources(),
    traceDirectory,
    traceFileCount: traceFileCount(),
  };

  const serialized = JSON.stringify(payload);

  try {
    writeFileSync(join(traceDirectory, 'summary.json'), serialized);
  } catch {
    // A missing summary file must not turn a passing suite into a failing one.
  }

  process.stdout.write(`TAU_PR_REVIEW_DIAGNOSTICS ${serialized}\n`);
};
