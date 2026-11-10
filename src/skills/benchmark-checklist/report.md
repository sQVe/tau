# Benchmark: <claim>

- Claim: <what is faster or slower, and by how much>
- Timed region: <the exact work the timer covers, and what it leaves out>
- Correctness: <how you checked that the work is correct and that it ran>
- Sensitivity: <the smallest change the harness showed it can detect, and how you showed it>
- Setup: <machine, inputs, settings, and the command for each version>
- Runs: <the number of interleaved rounds, or "one run, spread not measured" for a ballpark>

| Version | Median | Spread (min to max) |
| ------- | ------ | ------------------- |
| <A>     | <time> | <time> to <time>    |
| <B>     | <time> | <time> to <time>    |

- Verdict: <faster, slower, no difference, or inconclusive>
- Action: <kept the change, or dropped it because it showed no gain>
