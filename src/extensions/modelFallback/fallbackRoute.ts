import { isRecord } from '../../schema.js';

type FallbackRouteReason = 'user' | 'continuation' | 'retry' | 'direct';

type FallbackTarget = 'primary' | 'fallback';

export interface FallbackRouteState {
  version: 1;
  consecutiveRetries: number;
  onFallback: boolean;
}

export interface FallbackRouteFacts {
  reason: FallbackRouteReason;
  state: unknown;
  previousOnFallback: boolean;
  fallbackAtRetry: number;
}

export interface FallbackRouteDecision {
  target: FallbackTarget;
  state: FallbackRouteState;
}

const stateKeys = ['version', 'consecutiveRetries', 'onFallback'] as const;

const hasStateKeys = (value: Record<string, unknown>): boolean =>
  Object.keys(value).length === stateKeys.length &&
  stateKeys.every((key) => Object.hasOwn(value, key));

const isRetryCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const parseFallbackRouteState = (value: unknown): FallbackRouteState | undefined => {
  if (!isRecord(value) || !hasStateKeys(value)) {
    return undefined;
  }

  const { version, consecutiveRetries, onFallback } = value;

  if (version !== 1 || !isRetryCount(consecutiveRetries) || typeof onFallback !== 'boolean') {
    return undefined;
  }

  return { version, consecutiveRetries, onFallback };
};

const primaryState = (): FallbackRouteState => ({
  version: 1,
  consecutiveRetries: 0,
  onFallback: false,
});

const targetOf = (onFallback: boolean): FallbackTarget => (onFallback ? 'fallback' : 'primary');

const decideRetry = (
  current: FallbackRouteState,
  fallbackAtRetry: number,
): FallbackRouteDecision => {
  const consecutiveRetries = current.consecutiveRetries + 1;
  const onFallback = current.onFallback || consecutiveRetries >= fallbackAtRetry;

  return { target: targetOf(onFallback), state: { version: 1, consecutiveRetries, onFallback } };
};

const decideContinuation = (current: FallbackRouteState): FallbackRouteDecision => ({
  target: targetOf(current.onFallback),
  state: { version: 1, consecutiveRetries: 0, onFallback: current.onFallback },
});

export const decideFallbackRoute = ({
  reason,
  state,
  previousOnFallback,
  fallbackAtRetry,
}: FallbackRouteFacts): FallbackRouteDecision => {
  const current = parseFallbackRouteState(state) ?? primaryState();

  switch (reason) {
    case 'user':
      return { target: 'primary', state: primaryState() };
    case 'retry':
      return decideRetry(current, fallbackAtRetry);
    case 'continuation':
      return decideContinuation(current);
    case 'direct':
      return { target: targetOf(previousOnFallback), state: current };
    default:
      return reason satisfies never;
  }
};
