// A dev server can compile on its first request, so a slow answer still counts.
const probeTimeout = 10_000;

// Any HTTP response, an error status included, shows that a server answers.
export const appAnswers = async (
  url: string,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  const timeout = AbortSignal.timeout(probeTimeout);
  const probeSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  try {
    const response = await fetch(url, { redirect: 'manual', signal: probeSignal });

    await response.body?.cancel();

    return true;
  } catch {
    signal?.throwIfAborted();

    return false;
  }
};
