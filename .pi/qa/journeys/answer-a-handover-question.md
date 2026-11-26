# Answer a handover question

## Who

The Tau user and a lead session that sent a handover.

## Goal

Unblock a handover session while the user is away, or pass its question on.

## Test

By hand, because it needs two live Pi sessions and `hc`.

## Steps

1. From the lead session, call `handover` `prepare` and write the task to a file in the printed
   directory. Then call `handover` `start` with that file, a short title of the work as `name`, the
   checkout's absolute path as `folder`, and the checkout's space ID as `space` when reusing a
   space.
   A new tab opens, and its task text starts with
   `Handover sender: terminal <terminal>, session <sessionId>.`
2. In the new session, ask it to change a test that contradicts its brief.
   It calls `handover_question`, and its turn ends.
   `hc get <terminal> --json` on its terminal shows no `blocked` status.
3. The lead session shows `Handover question <questionId> from terminal ...` as an inbox message.
   Set the lead's session file while the lead runs:

   ```sh
   lead_session=$(hc get <lead terminal> --json | jq -r '.labels["pi.session"]')
   echo "$lead_session"
   ```

   It prints the session file path.
4. Tell the lead to answer with `handover_answer`, using the `questionId` from the step 3 message
   and an answer such as `Change the test to match the brief.`
   The asker starts a new turn whose message starts with
   `Handover answer to question <questionId>:`.
5. In the asker, ask a question about canceling a ticket.
   The lead shows `ask_user_question`.
   Answer it. The lead passes your answer with `handover_answer`, and your answer reaches the asker
   in a new turn whose message starts with
   `Handover answer to question <second questionId>:`.
6. End the lead session with `hc kill <lead terminal>`, then make the asker ask again.
   `handover_question` refuses with `The lead that sent this handover cannot be reached:`, deletes
   that question's record, and the asker then opens `ask_user_question` itself.

## End state

Set the asker's checkout and its session file, and use the lead's session file from step 3:

```sh
asker=$(hc get <asker terminal> --json | jq -r .cwd)
asker_session=$(hc get <asker terminal> --json | jq -r '.labels["pi.session"]')
```

Two question records are answered, and none is open:

```sh
jq -r '[.state, .questionId] | @tsv' "$asker"/.tau/handoverQuestions/*.json
jq -r 'select(.state == "open") | .questionId' "$asker"/.tau/handoverQuestions/*.json
```

The first command prints two lines, and both start with `answered`. The second prints nothing.

The refused question has no record file:

```sh
refused=$(jq -r 'select(.type == "message" and .message.role == "toolResult"
  and .message.toolName == "handover_question" and .message.isError == true)
  | .message.details.questionId' "$asker_session" | tail -n 1)
test -n "$refused" && test ! -e "$asker/.tau/handoverQuestions/$refused.json" \
  && echo "no record for $refused"
```

It prints `no record for <refused question ID>`.

The lead received two questions:

```sh
jq -r 'select(.type == "custom_message" and .customType == "tau-inbox-message")
  | .details | select(.family == "handover-question") | .questionId' "$lead_session"
```

It prints the question IDs from steps 3 and 5.

The asker received two answers:

```sh
jq -r 'select(.type == "custom_message" and .customType == "tau-inbox-message")
  | .details | select(.family == "handover-answer") | .questionId' "$asker_session"
```

It prints the same two question IDs.
