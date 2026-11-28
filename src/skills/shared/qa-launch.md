# QA launch

Use this procedure when sending a change to a `qa` worker.

1. When the repository has `.pi/qa.md`, read it before the launch.
   - State which sections apply to the change and why, and assign them in the brief.
   - Include a section when the impact on it is unclear.
   - State which journeys from the guide's "Journeys" index and which feature files from its
     "Features" index apply and why, and assign their files under `.pi/qa/journeys/<name>.md` and
     `.pi/qa/features/<name>.md` in the brief.
   - When only the guide's "Not testable" part applies, launch no worker. Report that QA did not
     run, with the reason.
2. Reuse an earlier QA run only when the committed content, assigned sections, journeys, and feature
   files, and the guide's "Reach it" proof still hold. Otherwise run QA again or report the gap.
3. Prepare the assigned sections before launching.
   - Do the guide's steps under "The manager starts" for a section whose target is `none`.
   - For each assigned section whose guide line is `Target: <name>`, call `verification` `launch`
     with that target, once per target. On `failed`, read its log, call `stop` unless `stopped` is
     true; when that stop reports `stopped: false`, report the run as still open with its `logPath`.
     Report that QA did not run for those sections. On `ready`, call `register` once per run with
     all assigned journey and feature items of that target's sections, each with its step count.
     Name each item by its file's path under `.pi/qa/` without `.md`, such as `features/new-ticket`,
     because the worker records results under that exact name.
   - Ask the user for the guide's steps under "Ask the user".
   - Put the lines the guide asks for in the brief, and `Verification run: <run>` and
     `Run directory: <directory>` from the launch result.
   - Give each registered item to exactly one worker, and list it under its run's
     `Verification run:` line in the brief. A section with `Target: none` keeps its "The manager
     starts" steps; assign its items apart from any run, and the worker reports them in prose.
4. Pass `url` when the user's Tau config has no `urlCommand`, because Tau then has no app URL to
   fill. When the config has `urlCommand`, leave the app URL to Tau. Leave the test account and data
   writes to Tau in both cases, and ask the user nothing about them in advance.
5. Launch the worker with the brief. Pass a blocking question from the worker to the user.
6. Call `verification` `stop` on each run, and do the guide's Stop step for each thing you started
   by hand, after every worker that uses it has reported. Read `stopped`: when it is false, report
   the run as still open with its `logPath`, and do not treat cleanup as done. When a `qa` worker
   fails to start, stop what it would have used only when no running worker uses it. A failed target
   launch is handled in step 3.
7. Report each run's name and directory, and each registered item with no saved result file, which
   counts as not run. The manager never records a result for a worker.
