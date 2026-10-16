export interface IdleFacts {
  now: number;
  lastOutputAt: number;
  idleLimitMilliseconds: number;
}

export const commandIsIdle = (facts: IdleFacts): boolean =>
  facts.now - facts.lastOutputAt >= facts.idleLimitMilliseconds;
