---
'tau': minor
---

Show aligned live worker progress and browse grouped worker history, reports, recovery details,
model observations, and available Pi usage. Worker panes display their name with the harness and a
known model, and unresolved worker states use explicit counts instead of a generic attention label.
Worker details include the latest phase description and its report time.

The compact widget lists worker name, status, short task name, and model. Related columns stay
adjacent, the model is muted and drops first on narrow terminals, and unused width stays after the
last column. The full model stays in the details view. When nothing is active or waiting, the widget
renders one muted summary line with stopped, status-unknown, and cleanup-unconfirmed counts instead
of a box of records that can no longer change. Those records stay in history.

History rows show the worker name, state, short task label, optional model, and one right-aligned
time. The filter matches the displayed label, and the full task prompt stays in the details view.
Launch and follow-up accept an optional short label; older records fall back to the first meaningful
task line.

The selected details show a short task name and key facts first. The full task prompt is a separate
section, keeps its paragraphs, and is reachable on demand. `ctrl+d` and `ctrl+u` scroll half a page.
