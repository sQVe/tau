#!/usr/bin/env bash
# Counts how often Pi sessions reach the bulk_read clamp. ADR 0014 records the result.
set -euo pipefail

readonly sessions_dir="${1:-${HOME}/.pi/agent/sessions}"

find "${sessions_dir}" -type f -name '*.jsonl' -print0 \
  | while IFS= read -r -d '' session; do
    jq -rs '
      [.[] | select(.type == "message") | .message] as $messages
      | [$messages[] | select(.role == "assistant") | .content[]?
          | select(.type == "toolCall")] as $calls
      | (reduce ($messages[] | select(.role == "toolResult")) as $result
          ({}; .[$result.toolCallId] = $result)) as $results
      | [$calls[] | select(.name == "read")] as $reads
      | [$calls[] | select(.name == "bulk_read")] as $bulk
      | def cost($role):
          [$messages[] | select(.role == $role) | .usage.cost.total // 0] | add // 0;
        def continued:
          test("\\n\\n\\[[^\\n]*Use offset=[0-9]+ to continue\\.\\]$") or
          test("\\n\\nFile continues at line [0-9]+\\.");
        [1, ($reads | length),
         ([$reads[] | select(.arguments.limit == null)] | length),
         ([$reads[] | $results[.id] | [.content[]? | select(.type == "text") | .text]
           | join("\n") | select(continued)] | length),
         ([$reads[] | select((.arguments.offset // 0) > 1)] | length),
         ($bulk | length), cost("assistant"), cost("toolResult"),
         (if ($bulk | length) > 0 then 1 else 0 end),
         ([$bulk[] | $results[.id].usage.cost.total // 0] | add // 0),
         (if ($bulk | length) > 0 then cost("assistant") else 0 end)]
      | @tsv
    ' "${session}"
  done \
  | awk '
    { for (column = 1; column <= NF; column++) totals[column] += $column }
    END {
      printf "Sessions: %d\nread calls: %d\nUnbounded reads: %d\n", totals[1], totals[2], totals[3]
      printf "Truncated or hinted: %d (%.1f%%)\n", totals[4], totals[2] ? 100 * totals[4] / totals[2] : 0
      printf "Offset pages (upper bound): %d\nbulk_read calls: %d\n", totals[5], totals[6]
      printf "Cost by role: assistant $%.2f; toolResult $%.2f\n", totals[7], totals[8]
      printf "Sessions using bulk_read: %d\n", totals[9]
      printf "bulk_read cost: $%.2f; assistant cost in those sessions: $%.2f\n", totals[10], totals[11]
    }
  '
