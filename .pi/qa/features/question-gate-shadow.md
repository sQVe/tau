# Question gate shadow record

Target: pi-session

Only the manager runs this feature's session. The dialog needs a person at the terminal, and a
`qa` worker cannot type into it.

## Entry points

`pi --no-extensions --extension "$checkout/src/tau.ts"`, run in a scratch Git repository with an
isolated `PI_CODING_AGENT_DIR`. The manager session calls `ask_user_question`, the user answers the
dialog, and Tau writes one shadow record.

## Driving steps

1. Set `run` to the run name from the brief and `checkout` to this worktree. Create a scratch
   repository, an isolated agent directory, and an evidence directory.

```sh
run=<run>
checkout=<worktree path from the brief>
scratch=$(mktemp -d "/tmp/tau-verification-$run/qa-XXXXXX")
agent=$(mktemp -d "/tmp/tau-verification-$run/agent-XXXXXX")
evidence=$(mktemp -d "/tmp/tau-verification-$run/evidence-XXXXXX")
git -C "$scratch" init --quiet
mkdir -p "$agent/sessions"
```

2. Write `$agent/tau.json`. Use the allowed model references from the brief for `classifier` and
   `panel`. The `shadow` block uses one past answer.

```sh
cat > "$agent/tau.json" <<'CONFIG'
{
  "allowedModels": ["<classifier>", "<panel-a>", "<panel-b>", "<panel-c>"],
  "questionGate": {
    "classifier": "<classifier>",
    "panel": ["<panel-a>", "<panel-b>", "<panel-c>"],
    "shadow": {
      "variant": "classifierExamples",
      "cutoff": 0.8,
      "examples": [
        {
          "time": 1,
          "question": {
            "question": "Which layout should the dashboard use?",
            "problem": "The dashboard ships next week.",
            "impact": "Changing the layout later moves every panel.",
            "options": [
              { "label": "Stacked", "description": "One column.", "recommended": true },
              { "label": "Split", "description": "Two columns.", "recommended": false }
            ]
          },
          "outcome": { "kind": "typed", "text": "Stacked" }
        }
      ]
    }
  }
}
CONFIG
```

3. Write the prompt outside the scratch repository. The question is eligible: one question, explicit
   `choice`, one recommendation, no preview, and no multi-select.

```sh
cat > "$scratch.prompt" <<'PROMPT'
This is a manager-run check with a user at the terminal. Call the tool ask_user_question exactly once with this JSON. Then reply with the tool result and stop.

{"questions":[{"question":"Which layout should the dashboard use?","problem":"The dashboard ships next week.","impact":"Changing the layout later moves every panel.","header":"Layout","kind":"choice","options":[{"label":"Stacked","description":"One column. Simple, but wide screens waste space.","recommended":true},{"label":"Split","description":"Two columns. Uses wide screens, but needs a fallback."}]}]}
PROMPT
```

4. Start the session from the scratch repository in a terminal tab where the user can answer the dialog.
   The user presses Enter on the recommended option `Stacked`.

```sh
cd "$scratch"
PI_CODING_AGENT_DIR="$agent" pi --no-extensions --extension "$checkout/src/tau.ts" \
  --model <model> --session-dir "$agent/sessions" "$(cat "$scratch.prompt")"
```

5. Record the branch-loaded source and the three probes before the audit. Run the package version
   check from the checkout. No skipped probe passes.

```sh
printf '%s\n' "$checkout" > "$evidence/source.txt"
test -d "$scratch" && echo "scratch: present" > "$evidence/scratch.txt"
pi --version > "$evidence/pi-version.txt"
(cd "$checkout" && pnpm pi-version:check) > "$evidence/pi-version-check.txt" 2>&1
```

6. Record the input, the dialog result, and the shadow record. Run this from the scratch repository.
   The session log is under `$agent/sessions`. Pi saves messages, not live events: the assistant
   message holds the `toolCall` content and the `toolResult` message holds the dialog result. Match
   the two by call ID and fail when either message is missing.

```sh
cd "$scratch"
log=$(find "$agent/sessions" -name '*.jsonl' -type f | head -n 1)
call_id=$(jq -r 'select(.message.role == "assistant") | .message.content[]?
  | select(.type == "toolCall" and .name == "ask_user_question") | .id' "$log")
test "$(printf '%s\n' "$call_id" | grep -c .)" -eq 1 \
  || { echo "expected one ask_user_question call in $log" >&2; exit 1; }
jq -c --arg id "$call_id" 'select(.message.role == "assistant") | .message.content[]?
  | select(.type == "toolCall" and .id == $id) | .arguments' \
  "$log" > "$evidence/input.json"
jq -c --arg id "$call_id" 'select(.message.role == "toolResult" and .message.toolCallId == $id)
  | .message.details' "$log" > "$evidence/dialog-result.json"
test -s "$evidence/input.json" \
  || { echo "no tool call arguments for $call_id in $log" >&2; exit 1; }
test -s "$evidence/dialog-result.json" \
  || { echo "no tool result for $call_id in $log" >&2; exit 1; }
record=$(find "$scratch/.tau/questions" -name 'shadow-*.json' -type f | head -n 1)
cp "$record" "$evidence/record.json"
printf '%s\n' "$log" > "$evidence/session-log.txt"
```

## Observable results

- `$evidence/source.txt` names this worktree.
- `$evidence/scratch.txt` holds `scratch: present`.
- `$evidence/pi-version.txt` and `$evidence/pi-version-check.txt` hold the command output.
- `$evidence/input.json` holds one question with `"kind":"choice"`, one `"recommended":true`, no
  `preview`, and no `multiSelect`.
- `$evidence/dialog-result.json` holds `"kind":"answered"` and the selected label `Stacked`.
- `$evidence/record.json` holds `"version":1`, `"kind":"shadow"`, the same question, the answer, and
  the five judge entries `classifier`, `classifierExamples`, `panel`, `panelExamples`, and `agent`.
- The session log shows one `ask_user_question` call. A `qa` worker checks these files, not the
  terminal rendering.

## End state

The evidence directory holds the source, the three probe outputs, the tool input, the dialog result,
and one v1 shadow record. The item stays open when the evidence has no real manager tool call.

## Gotchas

- A worker's own tool call is not evidence. Only a manager session that loads `$checkout/src/tau.ts`
  counts.
- Do not substitute `pnpm pi-session`. It cannot show the dialog and cannot be answered.
- An omitted `kind` is valid but never sampled. The synthetic question must set `"kind":"choice"`.
- A missing or invalid `questionGate` config makes no judge calls and writes no record.
- A recent batch from the same process blocks the next batch for 60 seconds. Start one session per
  audit.
