import type { Static } from '@sinclair/typebox';

import type { configSchema } from './schema.js';

export class ConfigValidationError extends Error {
  readonly field: string | string[];
  readonly reason: string;

  constructor(field: string | string[], reason: string) {
    const fieldLabel = Array.isArray(field) ? field.join(', ') : field;
    super(`Invalid tau.config.json at ${fieldLabel}: ${reason}`);
    this.name = 'ConfigValidationError';
    this.field = field;
    this.reason = reason;
  }
}

export type Config = Static<typeof configSchema>;
