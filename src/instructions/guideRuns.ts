import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { resolveStommeGuides } from './stommeGuides/stommeGuides.js';
import type { GuideSnapshot } from './stommeGuides/stommeGuides.js';
import type { Guide } from './stommeGuides/stommeGuidesDecision.js';

export interface GuideRuns {
  snapshot: () => Promise<GuideSnapshot>;
}

const brokenNotice = (reason: string): string =>
  `Tau could not load the stomme coding guides: ${reason}`;

const guideFolder = (snapshot: Exclude<GuideSnapshot, { kind: 'broken' }>): string =>
  snapshot.kind === 'project'
    ? `from ${join(snapshot.root, 'docs', 'stomme')}/`
    : 'bundled with Tau';

const guideSection = (guide: Guide): string =>
  `Source: docs/stomme/${guide.path}\n\n${guide.text.trim()}`;

export const codingSetText = (snapshot: GuideSnapshot): string => {
  if (snapshot.kind === 'broken') {
    return `${brokenNotice(snapshot.reason)}. Tell the user before you change any code.`;
  }

  const heading = `# Stomme ${snapshot.version} coding guides, ${guideFolder(snapshot)}`;

  return [heading, ...snapshot.guides.map(guideSection)].join('\n\n');
};

// Each Pi run reads the guides once, so a run never mixes two versions between model calls.
export const trackGuideRuns = (
  pi: Pick<ExtensionAPI, 'on'>,
  resolve = resolveStommeGuides,
): GuideRuns => {
  let run: Promise<GuideSnapshot> | undefined;
  let lastReason: string | undefined;

  pi.on('before_agent_start', async (_event, context) => {
    run = resolve(context.cwd);

    const snapshot = await run;

    if (snapshot.kind !== 'broken') {
      lastReason = undefined;

      return;
    }

    if (snapshot.reason !== lastReason) {
      lastReason = snapshot.reason;
      context.ui.notify(brokenNotice(snapshot.reason), 'error');
    }
  });

  return {
    snapshot: () => {
      run ??= resolve(process.cwd());

      return run;
    },
  };
};
