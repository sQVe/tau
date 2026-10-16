// state[0]: heartbeat counter. state[1]: blocking budget, 0 for none. state[2]: collection
// deadline, 0 once collection has finished.
export const watchdogSource = `
const { workerData } = require('node:worker_threads');
const { readdirSync, readFileSync, writeSync } = require('node:fs');
const state = new Int32Array(workerData.state);
const label = new Uint8Array(workerData.label);
const startedAt = performance.now();
let lastBeat = Atomics.load(state, 0);
let lastChange = startedAt;
const startParent = process.ppid;
// Reads /proc without spawning, because a spawn can block while the worker is wedged.
const parentOf = (pid) => {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return undefined;
  }
};
const descendants = () => {
  if (process.platform !== 'linux') return [];
  const parents = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const parent = parentOf(entry);
    if (parent !== undefined) parents.set(Number(entry), parent);
  }
  const found = [];
  const queue = [process.pid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [pid, parent] of parents) {
      if (parent === current) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
};
const kill = (reason) => {
  try {
    const length = label.indexOf(0);
    const name = Buffer.from(label.slice(0, length < 0 ? label.length : length)).toString();
    writeSync(2, 'Hang in ' + name + ' ' + reason + '. Killing the worker.\\n');
  } catch {
    // stderr may point at a dead parent, and the kill must still run.
  }
  try {
    for (const pid of descendants().reverse()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process already exited.
      }
    }
  } finally {
    process.kill(process.pid, 'SIGKILL');
  }
};
setInterval(() => {
  if (process.ppid !== startParent) {
    kill('lost its parent process');
  }
  const now = performance.now();
  const collection = Atomics.load(state, 2);
  if (collection !== 0 && now - startedAt >= collection) {
    kill('did not finish collecting before its deadline');
  }
  const beat = Atomics.load(state, 0);
  const budget = Atomics.load(state, 1);
  if (beat !== lastBeat || budget === 0) {
    lastBeat = beat;
    lastChange = now;
    return;
  }
  if (now - lastChange >= budget) {
    kill('blocked the event loop past its timeout');
  }
}, 50);
`;
