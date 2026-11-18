import type { ModelRouteReason } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

type FallbackTarget = 'primary' | 'fallback';

export interface FallbackRouteFacts {
  reason: ModelRouteReason;
  state: unknown;
  previousOnFallback: boolean;
  fallbackAtRetry: number;
}

export interface FallbackRouteDecision {
  target: FallbackTarget;
  state?: FallbackRouteState;
}

const fallbackRouteStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    consecutiveRetries: Type.Integer({ minimum: 0 }),
    onFallback: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type FallbackRouteState = Static<typeof fallbackRouteStateSchema>;

const parseFallbackRouteState = (value: unknown): FallbackRouteState | undefined =>
  Value.Check(fallbackRouteStateSchema, value) ? value : undefined;

const primaryState = (): FallbackRouteState => ({
  version: 1,
  consecutiveRetries: 0,
  onFallback: false,
});

const isPrimaryState = (state: FallbackRouteState | undefined): boolean =>
  state?.consecutiveRetries === 0 && !state.onFallback;

const decideUser = (current: FallbackRouteState | undefined): FallbackRouteDecision =>
  isPrimaryState(current) ? { target: 'primary' } : { target: 'primary', state: primaryState() };

const targetOf = (onFallback: boolean): FallbackTarget => (onFallback ? 'fallback' : 'primary');

const decideRetry = (
  current: FallbackRouteState,
  fallbackAtRetry: number,
): FallbackRouteDecision => {
  const consecutiveRetries = current.consecutiveRetries + 1;
  const onFallback = current.onFallback || consecutiveRetries >= fallbackAtRetry;

  return { target: targetOf(onFallback), state: { version: 1, consecutiveRetries, onFallback } };
};

const decideContinuation = (current: FallbackRouteState | undefined): FallbackRouteDecision => {
  if (current === undefined) {
    return { target: 'primary', state: primaryState() };
  }

  const target = targetOf(current.onFallback);

  if (current.consecutiveRetries === 0) {
    return { target };
  }

  return { target, state: { version: 1, consecutiveRetries: 0, onFallback: current.onFallback } };
};

export const decideFallbackRoute = ({
  reason,
  state,
  previousOnFallback,
  fallbackAtRetry,
}: FallbackRouteFacts): FallbackRouteDecision => {
  const current = parseFallbackRouteState(state);

  switch (reason) {
    case 'user':
      return decideUser(current);
    case 'retry':
      return decideRetry(current ?? primaryState(), fallbackAtRetry);
    case 'continuation':
      return decideContinuation(current);
    case 'direct':
      return { target: targetOf(previousOnFallback) };
    default:
      return reason satisfies never;
  }
};
