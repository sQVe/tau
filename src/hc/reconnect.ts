export interface ReconnectPlan {
  delay: number;
  lasting: boolean;
}

const firstRetryMilliseconds = 5_000;
const secondRetryMilliseconds = 15_000;
const thirdRetryMilliseconds = 45_000;

const retryDelays = [firstRetryMilliseconds, secondRetryMilliseconds, thirdRetryMilliseconds];

export const retryDelay = (attempt: number): number | undefined => retryDelays[attempt];

const lastRetryDelay = retryDelays.at(-1) ?? 0;

export const decideReconnect = (attempt: number): ReconnectPlan => {
  const next = retryDelay(attempt);

  return next === undefined
    ? { delay: lastRetryDelay, lasting: true }
    : { delay: next, lasting: false };
};
