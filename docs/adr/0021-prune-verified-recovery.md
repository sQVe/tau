# ADR 0021: Prune recovery snapshots after verified restoration

- Status: Proposed
- Date: 2026-09-12

## Context

[ADR 0019](./0019-verified-raw-recovery.md) retains every recovery archive after a successful
restoration, on the grounds that deleting it could discard user work written to displaced files.
Each archive holds a full copy of the working files, a manifest with two more copies, index
snapshots, and a Git ref that pins an otherwise unreachable tree. A check window runs on every
commit, so a repository accumulates several megabytes per commit with no removal path.

Only the displaced inodes can receive late writes: a process that held a file open before hiding
keeps writing to the moved inode. The snapshots and the ref are consulted only during restoration,
and verified restoration has already compared the working tree against them.

## Options considered

- Retain everything, as ADR 0019 requires. Unbounded growth and refs that block garbage collection.
- Delete the whole archive after success. Discards bytes an open writer may still be appending.
- Delete the snapshots and the ref, keep the displaced inodes. Bounded by what open writers can
  still touch.

## Decision

After a restoration verifies, remove the working snapshot, the manifest, the index copies, and the
recovery ref. Keep the displaced inode directories, a list of the paths their numeric names index,
and the recovery instructions. Remove the archive entirely when nothing was displaced.

Write the path list before removing anything, so an interrupted prune never leaves unnamed inodes. A
failed prune is not a failed restoration: leftovers are harmless, so a locked ref or a busy file
must not turn a verified restoration into an error.

This replaces the retention sentence in ADR 0019. Restoration conditions, pending-recovery blocking,
and manual inspection for uncertain states are unchanged.

## Tradeoffs

- Archives still grow by the displaced inodes when files were hidden, so growth is small but not
  zero. Removing those needs a separate decision about when a writer can be assumed closed.
- The pack written for the recovery ref stays until Git's own garbage collection runs, so disk space
  is reclaimed lazily.
