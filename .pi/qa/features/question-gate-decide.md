# Question gate decide mode

Target: pi-session

Only the manager runs this feature's session. The first session answers without a dialog, and the
second needs a person at the terminal to close its dialog. A `qa` worker cannot type into either.

## Entry points

`pi --no-extensions --extension "$checkout/src/tau.ts"`, run in a scratch Git repository with an
isolated `PI_CODING_AGENT_DIR`. The manager calls `ask_user_question` in two sessions. The first call
is eligible and the gate answers it. The second is an approval and opens the dialog.

## Driving steps

1. Set `run` to the run name from the brief and `checkout` to this worktree. Create a scratch
   repository with one empty commit, an isolated agent directory, and an evidence directory.

```sh
run=<run>
checkout=<worktree path from the brief>
mkdir -p "/tmp/tau-verification-$run"
scratch=$(mktemp -d "/tmp/tau-verification-$run/qa-XXXXXX")
agent=$(mktemp -d "/tmp/tau-verification-$run/agent-XXXXXX")
evidence=$(mktemp -d "/tmp/tau-verification-$run/evidence-XXXXXX")
git -C "$scratch" init --quiet
git -C "$scratch" -c user.name=qa -c user.email=qa@example.invalid \
  commit --allow-empty --quiet -m 'start'
mkdir -p "$agent/sessions-one" "$agent/sessions-two"
```

2. Write `$agent/tau.json`. Use the allowed model references from the brief for `classifier` and
   `panel`. Decide mode uses the frozen shadow candidate with the `agent` variant and cutoff 0.9.

```sh
cat > "$agent/tau.json" <<'CONFIG'
{
  "questionGate": {
    "classifier": "<classifier>",
    "panel": ["<panel-a>", "<panel-b>", "<panel-c>"],
    "decide": true,
    "shadow": {
      "variant": "agent",
      "cutoff": 0.9,
      "examples": []
    }
  }
}
CONFIG
```

3. Write the first prompt outside the scratch repository. The question is eligible: one question,
   explicit `choice`, one recommendation, no preview, no multi-select, and `confidence` 0.99 above
   the cutoff.

```sh
cat > "$evidence/prompt-one.txt" <<'PROMPT'
This is a manager-run check with a user at the terminal. Call the tool ask_user_question exactly once with this JSON. Then reply with the tool result and stop.

{"questions":[{"question":"Which layout should the dashboard use?","problem":"The dashboard ships next week.","impact":"Changing the layout later moves every panel.","header":"Layout","kind":"choice","confidence":0.99,"options":[{"label":"Stacked","description":"One column. Simple, but wide screens waste space.","recommended":true},{"label":"Split","description":"Two columns. Uses wide screens, but needs a fallback."}]}]}
PROMPT
```

4. Write the second prompt. The question is an approval with a question `preview`, so the gate must
   open the dialog instead of answering.

```sh
cat > "$evidence/prompt-two.txt" <<'PROMPT'
This is a manager-run check with a user at the terminal. Call the tool ask_user_question exactly once with this JSON. The user closes the dialog, then reply with the tool result and stop.

{"questions":[{"question":"Publish this draft?","problem":"The draft is ready to publish.","impact":"Publishing makes it visible to everyone.","header":"Publish","kind":"approval","preview":"Draft: the release notes for the next version.","options":[{"label":"Publish","description":"Make the draft public now.","recommended":true},{"label":"Keep private","description":"Leave the draft unpublished."}]}]}
PROMPT
```

5. Start the first session from the scratch repository. The gate answers, so no dialog opens. Start
   the second session in a terminal where the user can close its dialog with Escape.

```sh
cd "$scratch"
PI_CODING_AGENT_DIR="$agent" pi --no-extensions --extension "$checkout/src/tau.ts" \
  --model <model> --session-dir "$agent/sessions-one" "$(cat "$evidence/prompt-one.txt")"

PI_CODING_AGENT_DIR="$agent" pi --no-extensions --extension "$checkout/src/tau.ts" \
  --model <model> --session-dir "$agent/sessions-two" "$(cat "$evidence/prompt-two.txt")"
```

6. Record the branch-loaded source and the probes before the audit. Run the package version check
   from the checkout. No skipped probe passes.

```sh
printf '%s\n' "$checkout" > "$evidence/source.txt"
test -d "$scratch" && echo "scratch: present" > "$evidence/scratch.txt"
pi --version > "$evidence/pi-version.txt"
(cd "$checkout" && pnpm pi-version:check) > "$evidence/pi-version-check.txt" 2>&1
```

7. Run the auth probe on the first session log. It records the assistant's visible text. A session
   with no model reply leaves the item open, because no assistant text proves the model answered.

```sh
log_one=$(find "$agent/sessions-one" -name '*.jsonl' -type f | head -n 1)
jq -r 'select(.message.role == "assistant") | .message.content[]?
  | select(.type == "text") | .text' "$log_one" > "$evidence/model-reply.txt"
test -s "$evidence/model-reply.txt" \
  || { echo "no model reply; the item stays open" >&2; exit 1; }
```

8. Record the first input, result, notice text, and decision record. Run this from the scratch
   repository. Pi saves messages, not live events: match the call and result by call ID.

```sh
cd "$scratch"
call_id=$(jq -r 'select(.message.role == "assistant") | .message.content[]?
  | select(.type == "toolCall" and .name == "ask_user_question") | .id' "$log_one")
test "$(printf '%s\n' "$call_id" | grep -c .)" -eq 1 \
  || { echo "expected one ask_user_question call in $log_one" >&2; exit 1; }
jq -c --arg id "$call_id" 'select(.message.role == "assistant") | .message.content[]?
  | select(.type == "toolCall" and .id == $id) | .arguments' \
  "$log_one" > "$evidence/input.json"
jq -c --arg id "$call_id" 'select(.message.role == "toolResult" and .message.toolCallId == $id)
  | .message.details' "$log_one" > "$evidence/result.json"
jq -r --arg id "$call_id" 'select(.message.role == "toolResult" and .message.toolCallId == $id)
  | .message.content[]? | select(.type == "text") | .text' \
  "$log_one" > "$evidence/result-text.txt"
record=$(find "$scratch/.tau/questions" -name 'decision-*.json' -type f | head -n 1)
cp "$record" "$evidence/record.json"
branch=$(git -C "$scratch" branch --show-current)
head=$(git -C "$scratch" rev-parse HEAD)
jq -e --arg branch "$branch" --arg head "$head" \
  '.branch == $branch and .head == $head' "$record" >/dev/null
printf '%s\n' "$log_one" > "$evidence/session-log-one.txt"
```

9. Record the second result and prove it wrote no second decision record. The user pressed Escape,
   so the dialog result is `declined`.

```sh
log_two=$(find "$agent/sessions-two" -name '*.jsonl' -type f | head -n 1)
find "$scratch/.tau/questions" -name 'decision-*.json' | sort > "$evidence/records-after.txt"
call_id_two=$(jq -r 'select(.message.role == "assistant") | .message.content[]?
  | select(.type == "toolCall" and .name == "ask_user_question") | .id' "$log_two")
jq -c --arg id "$call_id_two" 'select(.message.role == "toolResult" and .message.toolCallId == $id)
  | .message.details' "$log_two" > "$evidence/dialog-result.json"
printf '%s\n' "$log_two" > "$evidence/session-log-two.txt"
```

## Observable results

- `$evidence/source.txt` names this worktree.
- `$evidence/scratch.txt` holds `scratch: present`.
- `$evidence/pi-version.txt` and `$evidence/pi-version-check.txt` hold the command output.
- `$evidence/model-reply.txt` is not empty. This is the auth probe: an empty file leaves the item
  open even when the other files exist.
- `$evidence/input.json` holds one question with `"kind":"choice"`, one `"recommended":true`, no
  `preview`, no `multiSelect`, and `"confidence":0.99`.
- `$evidence/result.json` holds `"kind":"decided"`, the selected label `Stacked`, and a `record`
  path. It does not hold a `notice` field.
- `$evidence/result-text.txt` holds one `Decided: Stacked, because One column.` line.
- `$evidence/record.json` holds `"version":1`, `"kind":"decision"`, the scratch branch and head, the
  same question, the choice `Stacked`, and `"variant":"agent"` with `"cutoff":0.9`.
- `$evidence/dialog-result.json` holds `"kind":"declined"`.
- `$evidence/records-after.txt` lists one `decision-*.json` file, so the approval call wrote none.
- The two session logs each show one `ask_user_question` call. A `qa` worker checks these files, not
  the terminal rendering.

## End state

The evidence directory holds the source, the probe outputs, the auth probe, both session logs, the
two inputs and results, the first result text, and the one decision record. The item stays open when
the first session has no model reply, when the first result is not `decided`, or when the second call
wrote another record.

## Gotchas

- A worker's own tool call is not evidence. Only a manager session that loads `$checkout/src/tau.ts`
  counts.
- Do not substitute `pnpm pi-session`. It cannot show the second dialog and cannot be answered.
- The `agent` variant uses the question's `confidence`, so prompt one needs `confidence` above the
  cutoff. It makes no model call for judging.
- An approval question and a question with a `preview` are ineligible. Both ask.
- Decide mode is off by default. A missing `decide: true` opens both dialogs.
- A reused branch name can list older decision records. Match the record's `time` and `head` before
  using it as evidence.
