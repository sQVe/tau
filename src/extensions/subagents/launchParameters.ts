import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { Static } from 'typebox';

export const visibility = Type.Optional(
  StringEnum(['foreground', 'background'] as const, {
    description:
      'Foreground opens beside the parent, background in a separate tab. Defaults to foreground for editing profiles. The result reports the actual placement.',
  }),
);

export const launchParameters = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 32_000 }),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: 'Short widget label, such as "Fix status counts".',
      }),
    ),
    acceptance: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
        maxItems: 50,
        description:
          'Acceptance criteria, one per item. Required for editing profiles and follow-ups of editing workers.',
      }),
    ),
    profile: Type.String({ minLength: 1 }),
    cwd: Type.Optional(Type.String()),
    url: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'qa and browser only: the http or https URL of the app under test. Tau refuses the launch when it does not answer, and adds it to the task.',
      }),
    ),
    model: Type.Optional(Type.String()),
    visibility,
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 10,
        maximum: 86_400,
        description: 'Defaults to 1800 for investigation profiles and 3600 for editing profiles.',
      }),
    ),
  },
  { additionalProperties: false },
);

export type LaunchParameters = Static<typeof launchParameters>;
