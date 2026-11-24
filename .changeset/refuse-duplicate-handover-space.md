---
'tau': patch
---

Refuse a `handover` `start` without `space` when the checkout folder already has a herdr space, and
name each space so the caller can reuse one. Pass `newSpace: true` to create another space. The
result reports `spaceStatus` as `created` or `reused`.
