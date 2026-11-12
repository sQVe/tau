# QA launch

Use this procedure when sending a change to a `qa` worker.

1. When the repository has `.pi/qa.md`, read it before the launch.
   - State which sections apply to the change and why, and assign them in the brief.
   - Include a section when the impact on it is unclear.
   - State which journeys from the guide's index apply and why, and assign their files under
     `.pi/qa/journeys/` in the brief.
   - When only the guide's "Not testable" part applies, launch no worker. Report that QA did not
     run, with the reason.
2. Reuse an earlier QA run only when the committed content, assigned sections and journeys, and the
   guide's "Reach it" proof still hold. Otherwise run QA again or report the gap.
3. Prepare the assigned sections before launching.
   - Do the guide's steps under "The manager starts".
   - Ask the user for the guide's steps under "Ask the user".
   - Put the lines the guide asks for in the brief.
4. Leave the app URL, test account, and data writes to Tau, which fills them from the user's config.
   Ask the user nothing about them in advance.
5. Launch the worker with the brief. Pass a blocking question from the worker to the user.
6. Stop what you started when every worker that uses it has reported, or when the launch fails.
7. Record what QA tested and found, or why it did not run, for the calling workflow.
