export interface CaptureState {
  hash: string;
  head: string;
}

export interface FreshnessFacts {
  recorded: CaptureState;
  // Undefined when the recapture or the HEAD read failed; captureErrors then says why.
  current: CaptureState | undefined;
  captureErrors: string[];
}

type FreshnessStatus = 'fresh' | 'stale' | 'unknown';

export interface Freshness {
  status: FreshnessStatus;
  reasons: string[];
}

const changes = (recorded: CaptureState, current: CaptureState) => {
  const reasons: string[] = [];

  if (current.hash !== recorded.hash) {
    reasons.push(`The capture hash changed from ${recorded.hash} to ${current.hash}.`);
  }

  if (current.head !== recorded.head) {
    reasons.push(`HEAD moved from ${recorded.head} to ${current.head}.`);
  }

  return reasons;
};

// A failed recapture cannot show whether the target changed, so it never counts as fresh.
export const decideFreshness = ({
  recorded,
  current,
  captureErrors,
}: FreshnessFacts): Freshness => {
  if (captureErrors.length > 0) {
    return { status: 'unknown', reasons: captureErrors };
  }

  if (current === undefined) {
    return { status: 'unknown', reasons: ['The target could not be captured again.'] };
  }

  const reasons = changes(recorded, current);

  return { status: reasons.length === 0 ? 'fresh' : 'stale', reasons };
};
