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
import { decideWatchStart } from './watchStart.js';

type WatchContext = Pick<ExtensionContext, 'cwd' | 'isIdle' | 'signal'>;

interface Watch {
  // Undefined until the resolve read returns.
  url: string | undefined;
  context: WatchContext;
  deadline: number;
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
  if (!isBashToolResult(event)) {
    return [];
  }

  const { command } = event.input;

  return typeof command === 'string' ? parseAutoMergeRequests(command) : [];
};

const readOutcome = async (exec: Exec, watch: Watch, url: string) => {
  const runtime = { exec, cwd: watch.context.cwd, signal: watch.reads.signal };

  const [pullRequest, checks] = await Promise.all([
    readPullRequestState(runtime, url),
    readRequiredChecks(runtime, url),
  ]);

  return decideWatchOutcome({ pullRequest, checks });
};

const stop = (watch: Watch) => {
  watch.reads.abort();
  clearTimeout(watch.pollTimer);
  clearTimeout(watch.deadlineTimer);
};

export const createMergeWatches = (exec: Exec, deliver: Deliver): MergeWatches => {
  const watches = new Set<Watch>();

  const end = (watch: Watch) => {
    stop(watch);
    watches.delete(watch);
  };

  const settle = (watch: Watch, url: string, outcome: WatchOutcome): boolean => {
    if (outcome.kind === 'waiting') {
      return true;
    }

    end(watch);
    deliver(watch.context, describeWatchOutcome(url, outcome));

    return false;
  };

  const schedule = (watch: Watch, url: string) => {
    if (Date.now() + pollInterval >= watch.deadline) {
      return;
    }

    const poll = async () => {
      const outcome = await readOutcome(exec, watch, url);

      if (!watch.reads.signal.aborted && settle(watch, url, outcome)) {
        schedule(watch, url);
      }
    };

    watch.pollTimer = setTimeout(() => {
      // oxlint-disable-next-line typescript/no-floating-promises -- Every gh read turns a failure into undefined, so a poll cannot reject.
      void poll();
    }, pollInterval);
  };

  const isWatched = (url: string) => [...watches].some((watch) => watch.url === url);

  // The time limit runs from before the resolve read, so a resolve that never returns is aborted too.
  const start = async (context: WatchContext, request: AutoMergeRequest) => {
    const expire = () => {
      if (watch.url === undefined) {
        end(watch);
      } else {
        settle(watch, watch.url, { kind: 'deadline' });
      }
    };

    const watch: Watch = {
      url: undefined,
      context,
      deadline: Date.now() + watchDuration,
      reads: new AbortController(),
      pollTimer: undefined,
      deadlineTimer: setTimeout(expire, watchDuration),
    };

    watches.add(watch);

    const runtime = { exec, cwd: context.cwd, signal: watch.reads.signal };
    const pullRequest = await resolvePullRequest(runtime, request);

    if (watch.reads.signal.aborted) {
      return;
    }

    if (pullRequest === undefined || !decideWatchStart(pullRequest) || isWatched(pullRequest.url)) {
      end(watch);

      return;
    }

    const { url } = pullRequest;

    watch.url = url;
    schedule(watch, url);
  };

  return {
    observe: (event, context) => {
      for (const request of autoMergeRequests(event)) {
        // oxlint-disable-next-line typescript/no-floating-promises -- resolvePullRequest turns every gh failure into undefined, so a start cannot reject.
        void start(context, request);
      }
    },
    stopAll: () => {
      for (const watch of watches) {
        end(watch);
      }
    },
  };
};
