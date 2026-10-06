# Checker assignment

Give the deep-mode checker the [review assignment](review-assignment.md), then add these rules and
the finder's candidates or the path `$dir/finder.md`.

```markdown
- First check each finder candidate against source, guards, callers, and tests. Give supported,
  refuted, or uncertain, with a rationale. Follow the returned-evidence rule: support or refute a
  candidate only with source, lines, and results that the capture, the evidence file, or your own
  script returned.
- Then look for omissions in the changed behavior and its relevant tests. Label anything new as
  found by the checker.
```
