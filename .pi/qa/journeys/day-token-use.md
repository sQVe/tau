# Review a day's token use

## Who

A Tau maintainer.

## Goal

Learn where the last day's tokens went and whether the sessions were healthy.

## Test

By hand, because the scripts read live logs under `~/.pi/agent/`.
Run each command in this worktree.

## Steps

1. Run `pnpm token-usage --since banana`.
   It exits with code 1 and prints `Cannot read the time "banana".` followed by usage help.
2. Run `pnpm token-usage --since 1d --top 3`.
   It exits with code 0 and prints a `Token use from` line with a 24-hour window.
   The `Top 3 sessions by tokens` table shows each session's tokens and file.
   Read the file column of the first row. A window without Pi use prints `0 session files` and a
   table without rows.
3. Run `pnpm session-health --since 1d`.
   It exits with code 0 and prints a `Session health from` line with a 24-hour window, by UTC day.
   It prints `Failed rules`, then the failed rules or `None`, followed by one table per UTC day.

## End state

The tester names the file of the top session, or says that the window had no session. The tester
also names the failed rules or `None` from the health report.
