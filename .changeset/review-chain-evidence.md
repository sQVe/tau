---
'tau': minor
---

Let `pr` `evidence` select the saved review chain and return its coverage. It no longer takes
`chain`; use `review` to choose a chain when several candidates match. The `pr` and `finish-slice`
skills use the returned chain instead of selecting and building one themselves.
