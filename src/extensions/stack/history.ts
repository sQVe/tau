import type { CommandRuntime } from '../../command.js';
import { runGit } from '../../git.js';
import {
  activeLayerParents,
  decideLayer,
  readAncestor,
  readCherry,
  readCommitCount,
  readRemoteTip,
  requireStackView,
} from './historyDecisions.js';
import type { LayerDecision, LayerFacts, LayerParents } from './historyDecisions.js';
import { gitCommandOutput } from './readResult.js';
import { gitLabel, readStackViewFacts } from './reads.js';

export interface HistoryRequest {
  remote: string;
  startTips: Readonly<Record<string, string>> | undefined;
}

type StartTips = ReadonlyMap<string, string>;

interface LayerHistory extends LayerDecision {
  branch: string;
  // The tip the checks used in place of the local branch, or null when they used the branch.
  startTip: string | null;
}

export interface HistoryResult {
  remote: string;
  trunk: string | null;
  layers: LayerHistory[];
  // Why no layer was checked, or null.
  stop: string | null;
  evidence: { layers: { branch: string; facts: LayerFacts }[] };
}

const startTipPattern = /^[\da-f]{7,64}$/u;

const branchRef = (name: string) => `refs/heads/${name}`;

const remoteRef = (remote: string, name: string) => `refs/remotes/${remote}/${name}`;

const tipRef = (tips: StartTips, name: string) => tips.get(name) ?? branchRef(name);

const gather = async (cwd: string, commandArguments: string[]) => {
  const output = gitCommandOutput(await runGit(cwd, commandArguments));

  return { command: gitLabel(commandArguments), output };
};

const readLayerFacts = async (
  cwd: string,
  remote: string,
  tips: StartTips,
  parents: LayerParents,
): Promise<LayerFacts> => {
  const { branch, newParent, oldParent } = parents;
  const tip = tipRef(tips, branch);
  const remoteBranch = remoteRef(remote, branch);

  const tipRead = await gather(cwd, ['rev-parse', '--verify', '--quiet', remoteBranch]);
  const remoteTip = readRemoteTip(tipRead.command, tipRead.output);

  if (!remoteTip.ok || remoteTip.value === null) {
    return { remoteTip, published: null };
  }

  const rebasedSincePush = tips.has(branch);

  const [unseen, ancestor, newCherry, oldCherry] = await Promise.all([
    gather(cwd, ['log', '--oneline', `${tip}..${remoteBranch}`]),
    rebasedSincePush
      ? undefined
      : gather(cwd, ['merge-base', '--is-ancestor', branchRef(branch), remoteBranch]),
    gather(cwd, ['cherry', tip, remoteBranch, remoteRef(remote, newParent)]),
    gather(cwd, ['cherry', remoteBranch, tip, tipRef(tips, oldParent)]),
  ]);

  return {
    remoteTip,
    published: {
      unseen: readCommitCount(unseen.command, unseen.output),
      ancestor: ancestor === undefined ? null : readAncestor(ancestor.command, ancestor.output),
      newCherry: readCherry(newCherry.command, newCherry.output),
      oldCherry: readCherry(oldCherry.command, oldCherry.output),
    },
  };
};

const rejectInvalidRequest = async (cwd: string, request: HistoryRequest) => {
  const remotes = await gather(cwd, ['remote']);

  const names = remotes.output.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (request.remote === '') {
    throw new Error('remote must not be empty.');
  }

  if (remotes.output.exitCode !== 0 || !names.includes(request.remote)) {
    throw new Error(`remote ${request.remote} is not a Git remote of this checkout.`);
  }

  for (const [branch, tip] of Object.entries(request.startTips ?? {})) {
    if (!startTipPattern.test(tip)) {
      throw new Error(`startTips for ${branch} must be a commit SHA, not ${tip}.`);
    }
  }
};

// Runs the remote-history check on every active branch of the stack.
export const readHistory = async (
  runtime: CommandRuntime,
  request: HistoryRequest,
): Promise<HistoryResult> => {
  const { cwd } = runtime;

  await rejectInvalidRequest(cwd, request);

  // A Map, so a branch named like an Object property, such as constructor, has no inherited tip.
  const tips: StartTips = new Map(Object.entries(request.startTips ?? {}));
  const view = requireStackView(await readStackViewFacts(runtime));

  if (!view.ok) {
    return {
      remote: request.remote,
      trunk: null,
      layers: [],
      stop: `${view.command} ${view.problem}`,
      evidence: { layers: [] },
    };
  }

  const { trunk, branches } = view.value;
  const parents = activeLayerParents(trunk, branches);

  const checked = await Promise.all(
    parents.map(async (layer) => ({
      branch: layer.branch,
      facts: await readLayerFacts(cwd, request.remote, tips, layer),
    })),
  );

  const layers = checked.map(({ branch, facts }) => ({
    branch,
    startTip: tips.get(branch) ?? null,
    ...decideLayer(facts),
  }));

  return { remote: request.remote, trunk, layers, stop: null, evidence: { layers: checked } };
};
