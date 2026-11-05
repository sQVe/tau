export type LeaseVerdict =
  | { kind: 'live'; sessionId: string; expiresAt: number }
  | { kind: 'expired'; sessionId: string; expiresAt: number }
  | { kind: 'absent' }
  | { kind: 'malformed' };

// The envelope schema's check rejects a longer value, so a lease that carries one cannot be queued.
const sessionIdLimit = 500;

export const isSessionId = (value: string): boolean =>
  value.length > 0 && value.length <= sessionIdLimit;

const parseExpiry = (text: string): number | undefined => {
  if (text.trim() === '') {
    return undefined;
  }

  const value = Number(text);

  return Number.isInteger(value) ? value : undefined;
};

export const judgeLease = (label: string | undefined, now: number): LeaseVerdict => {
  if (label === undefined) {
    return { kind: 'absent' };
  }

  const separator = label.lastIndexOf(':');

  if (separator === -1) {
    return { kind: 'malformed' };
  }

  const sessionId = label.slice(0, separator);
  const expiresAt = parseExpiry(label.slice(separator + 1));

  if (!isSessionId(sessionId) || expiresAt === undefined) {
    return { kind: 'malformed' };
  }

  if (now >= expiresAt) {
    return { kind: 'expired', sessionId, expiresAt };
  }

  return { kind: 'live', sessionId, expiresAt };
};
