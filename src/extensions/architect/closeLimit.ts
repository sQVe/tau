const closeLimitMilliseconds = 10_000;

// Callers that start together share one deadline.
export const settleWithinCloseLimit = async (
  pending: ReadonlySet<Promise<unknown>>,
): Promise<void> => {
  const expired = Promise.withResolvers<undefined>();

  const timer = setTimeout(() => {
    expired.resolve(undefined);
  }, closeLimitMilliseconds);

  try {
    await Promise.race([Promise.allSettled(pending), expired.promise]);
  } finally {
    clearTimeout(timer);
  }
};
