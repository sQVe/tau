import type { ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { isBashToolResult } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { parseAutoMergeRequests } from './autoMergeRequest.js';
import type { AutoMergeRequest } from './autoMergeRequest.js';
import type { Deliver } from './delivery.js';
import {
  readPullRequestState,
  readRequiredChecks,
  resolvePullRequest,
} from './pullRequestReads.js';
import { decideWatchOutcome, describeWatchOutcome } from './watchOutcome.js';
import type { WatchOutcome } from './watchOutcome.js';

type WatchContext = Pick<ExtensionContext, 'cwd' | 'isIdle' | 'signal'>;

interface Watch {
  url: string;
  context: WatchContext;
  reads: AbortController;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface MergeWatches {
  observe: (event: ToolResultEvent, context: WatchContext) => void;
  stopAll: () => void;
}

const pollInterval = 60_000;
const watchDuration = 7_200_000;

const autoMergeRequests = (event: ToolResultEvent): AutoMergeRequest[] => {
  if (!isBashToolResult(event) || event.isError) {
    return [];
  }

  const { command } = event.input;

  return typeof command === 'string' ? parseAutoMergeRequests(command) : [];
};

const readOutcome = async (exec: Exec, watch: Watch) => {
  const runtime = { exec, cwd: watch.context.cwd, signal: watch.reads.signal };

  const [pullRequest, checks] = await Promise.all([
    readPullRequestState(runtime, watch.url),
    readRequiredChecks(runtime, watch.url),
  ]);

  return decideWatchOutcome({ pullRequest, checks });
};

const stop = (watch: Watch) => {
  watch.reads.abort();
  clearTimeout(watch.pollTimer);
  clearTimeout(watch.deadlineTimer);
};

export const createMergeWatches = (exec: Exec, deliver: Deliver): MergeWatches => {
  const watches = new Map<string, Watch>();
  let session = new AbortController();

  const settle = (watch: Watch, outcome: WatchOutcome): boolean => {
    if (outcome.kind === 'waiting') {
      return true;
    }

    stop(watch);
    watches.delete(watch.url);
    deliver(watch.context, describeWatchOutcome(watch.url, outcome));

    return false;
  };

  const schedule = (watch: Watch, deadline: number) => {
    if (Date.now() + pollInterval >= deadline) {
      return;
    }

    const poll = async () => {
      const outcome = await readOutcome(exec, watch);

      if (!watch.reads.signal.aborted && settle(watch, outcome)) {
        schedule(watch, deadline);
      }
    };

    watch.pollTimer = setTimeout(() => {
      // oxlint-disable-next-line typescript/no-floating-promises -- Every gh read turns a failure into undefined, so a poll cannot reject.
      void poll();
    }, pollInterval);
  };

  const start = async (context: WatchContext, request: AutoMergeRequest) => {
    const { signal } = session;
    const url = await resolvePullRequest({ exec, cwd: context.cwd, signal }, request);

    if (url === undefined || signal.aborted || watches.has(url)) {
      return;
    }

    const watch: Watch = {
      url,
      context,
      reads: new AbortController(),
      pollTimer: undefined,
      deadlineTimer: undefined,
    };

    watch.deadlineTimer = setTimeout(() => {
      settle(watch, { kind: 'deadline' });
    }, watchDuration);

    watches.set(url, watch);
    schedule(watch, Date.now() + watchDuration);
  };

  return {
    observe: (event, context) => {
      for (const request of autoMergeRequests(event)) {
        // oxlint-disable-next-line typescript/no-floating-promises -- resolvePullRequest turns every gh failure into undefined, so a start cannot reject.
        void start(context, request);
      }
    },
    stopAll: () => {
      session.abort();
      session = new AbortController();

      for (const watch of watches.values()) {
        stop(watch);
      }

      watches.clear();
    },
  };
};
