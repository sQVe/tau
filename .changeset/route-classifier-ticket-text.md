---
'tau': minor
---

When a worker brief names a `.tau/slices/**/*.md` ticket file, the Jev route classifier now gets the
file's text with the brief, capped at 12,000 characters. The path can be absolute or relative to the
worker's directory, and it must stay inside `.tau/slices`. A brief without a path, or with a file
that cannot be read, is classified on the brief alone as before. Reading the file counts inside the
5-second classifier limit. Task records move to version 10 and save `ticketSent`, so shadow data can
compare routes with and without the ticket text. Version 9, 8, and 7 records stay readable.
