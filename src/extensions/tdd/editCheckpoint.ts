import { relative, resolve } from 'node:path';

import type {
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';

import { classifyPath } from './config.js';
import { observationDirectory } from './observation.js';
import type { ObservationTracker, TrackedObservation } from './observationTracker.js';
import { worktreePath } from './worktreePath.js';

const withNotice = (
  event: ToolResultEvent,
  context: ExtensionContext,
  text: string,
  level: 'info' | 'warning' = 'info',
) => {
  if (context.hasUI) {
    context.ui.notify(text, level);
  }

  return {
    content: [...event.content, { type: 'text' as const, text }],
    ...(event.structuredContent === undefined
      ? {}
      : { structuredContent: event.structuredContent }),
  };
};

export const handleToolResult = async (
  tracker: ObservationTracker,
  event: ToolResultEvent,
  context: ExtensionContext,
): Promise<ToolResultEventResult | undefined> => {
  if (!['write', 'edit', 'bash'].includes(event.toolName)) {
    return undefined;
  }

  let current: TrackedObservation;

  try {
    current = await tracker.observationFor(context);
  } catch (error) {
    const message = `TDD hints are paused: ${error instanceof Error ? error.message : String(error)}`;

    if (!tracker.recordConfigError(message)) {
      return undefined;
    }

    return withNotice(event, context, message, 'warning');
  }

  tracker.clearConfigError();
  const { cwd, loaded, observation } = current;
  const path = typeof event.input.path === 'string' ? event.input.path.replace(/^@/, '') : '';
  const target = resolve(context.cwd, path);
  const editablePath = event.toolName !== 'bash' && path.length > 0;
  const canonicalTarget = await observationDirectory(target);
  const editedPath = worktreePath(relative(context.cwd, target), relative(cwd, canonicalTarget));

  const productionEdit =
    !event.isError && editablePath && classifyPath(loaded.config, editedPath) === 'production';

  const hint = await observation.checkpoint(productionEdit);

  return hint === undefined ? undefined : withNotice(event, context, hint);
};
