# ADR 0029: Version worker provider fingerprints

- Status: Superseded by [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
- Date: 2026-09-16

## Context

Pi resolves and refreshes provider credentials. Including the resolved API key in a saved worker
fingerprint makes ordinary token rotation look like a configuration change. Other resolved auth
fields can select an endpoint, account header, region, or proxy.

## Options considered

- Keep credential-sensitive fingerprints for every task. This preserves existing behavior but
  refuses otherwise unchanged settings after token rotation.
- Exclude all resolved auth. This could silently accept changed routing or provider settings.
- Version the fingerprints and exclude only the resolved API-key field for new records. This allows
  narrow credential rotation without reinterpreting existing hashes.

## Decision

Use explicit fingerprint versions. New records exclude only the resolved `auth.apiKey` field.
Missing versions retain the original credential-sensitive semantics. Never migrate a fingerprint by
guessing what its hash included.

Keep configuration, resolved headers, endpoint, environment, model, and integration checks. Check
provider callback identity against a reconstruction in the parent process. Pi owns refresh; Tau must
not add credential retries or provider fallback.

Also bind new fingerprints to the complete `models.json` file in the saved agent directory. Pi's
registry does not expose its literal configuration inputs. Omitting that binding could hide a
changed literal key behind the resolved-key exclusion. A current file hash does not prove which
configuration an existing registry loaded.

Compare live provider settings with a fresh reconstruction at launch, saved-loadout validation, and
worker startup. Keep resolved API keys in these comparisons. Only the comparison with a historical
version 2 fingerprint omits that field. Unequal current keys could mean either refresh or stale
literal configuration; public APIs cannot distinguish them, so refuse both without retries.

At worker startup, reconstruct Pi settings using the runtime's public provider declarations. Do not
run extension factories again inside an active worker; doing so can change extension state.

## Tradeoffs

- API-key-field rotation between resolution and startup can preserve saved settings for new records.
- Cost: rotation during validation or runtime-only credentials can fail the strict current
  comparison.
- Cost: legacy credential changes and header-only credential rotation still refuse replay.
- Cost: any `models.json` edit, including unrelated providers or formatting, requires a fresh task.
- Cost: generic auth APIs do not establish that a rotated credential belongs to the same account.
- Cost: entry-file fingerprints do not freeze dependency graphs or all current Pi resource settings.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
