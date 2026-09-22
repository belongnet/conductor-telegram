# Command Center/Postgres lanes integration

The HTTP lane worker depends on the Command Center control plane for its
production ledger. The schema and transaction implementation are maintained in
the control-plane repository, not this worker repository:

- [Control-plane PR #427](https://github.com/belongnet/belong-agents/pull/427)
- [Pinned `conductor_lanes.py` implementation](https://github.com/belongnet/belong-agents/blob/2571748be708615e03eb54283aea2142b93fdf5c/belong-agent-center/backend/conductor_lanes.py)
- [Pinned PostgreSQL scenario](https://github.com/belongnet/belong-agents/blob/2571748be708615e03eb54283aea2142b93fdf5c/belong-agent-center/tests/postgres_conductor_lanes_scenario.py)
- [Pinned isolated HTTP/Postgres canary evidence](https://github.com/belongnet/belong-agents/pull/427#issuecomment-5592869350)

That pinned implementation defines the deployed `conductor_lane_runs` and
`conductor_lane_actions` tables in `PG_SCHEMA`. Its `finish_action` transaction
rejects an `ambiguous` action being resolved as `failed` (only authoritative
`reconciled` is accepted), and preserves `ambiguous_action_id` when an
unrelated action finishes. The linked canary calls the same
`/api/conductor/lanes/actions/:id/finish` HTTP endpoint against an isolated
PostgreSQL-backed service. The companion PostgreSQL scenario validates the
deployed schema, capacity, and fencing setup, with CI supplying
`TEST_POSTGRES_URL`; retain the linked canary artifact for finish-action
invariant evidence.

Before enabling the HTTP worker, land the control-plane PR (or a newer commit
with the same contract), run its PostgreSQL scenario, and point
`COMMAND_CENTER_API_BASE_URL` at that deployment. This worker repository does
not silently apply SQL to the control plane and keeps production prepare-only.

## Required lane-safety contract

The worker in this revision requires a matching Command Center deployment
before it is enabled. The snapshot must include:

```text
lane_controls: Array<{
  manifest_revision_id, lane_id,
  state: "held" | "retired" | "validation_authorized",
  control_id, run_id, previous_status, resume_status, resume_stage,
  merged_sha, evidence_refs_json, reason, updated_at, row_version
}>
```

The control endpoint must accept revision-bound `lane_hold`, `lane_release`,
`lane_validate`, and `lane_retire` controls. Hold requires a non-empty reason.
Release binds `expected_hold_control_id`; validate binds that same exact current
hold plus `expected_run_id` and `merged_sha`. A replaced hold/run/SHA invalidates
the queued approval. Release, validate, and retire require the separate human approval credential.
Finishing any of these controls must apply the lane-control record and run
transition in the same transaction as the control status; the worker does not
pre-apply either half. Hold preserves active attempts and bindings and stores
the exact prior status and stage. Validate authorizes only one held, merged,
one-shot validation run while the global controller remains paused. A rejected
`merged_ci` or `deterministic_validation` record must atomically restore that
run to `paused_safety` and its scoped control to `held`, without entering
repair. Provider disable/enable likewise updates provider health and resolves
the control in one transaction, so a lost response cannot double-apply a
breaker change after restart.

Every bounded `validation-workspace`, `validation-session`,
`validation-prompt`, and `validation-nudge` action carries an exact
`validation_scope` with revision/lane/run/attempt/merged-SHA identity plus the
SHA-256 of the manifest validation profile and immutable validation plan. The
plan repeats that identity, the four exact detached-checkout preflight command
strings, the manifest's raw command argv arrays, and its raw read-only probe
objects. Command Center recomputes both hashes from the active manifest and
rejects extra fields, a wrong stage/type pair, or a validation prompt whose
`authorized_git_actions` is not exactly empty. A legacy manifest that stored
Claude Fable may commission `sonnet-5-1m` only for this exact human-authorized,
globally paused validation run; it does not make Fable valid in a new manifest
or any other attempt path.

Retirement is limited to an already merged one-shot validation run. Its stored
merged SHA must match exactly, and every direct recurring dependent in the
active manifest must already be held or have a terminal current generation.
The transaction records accepted `legacy_validation_adoption` evidence before
ending the run as `validated`; it never guesses a GitLab SHA or synthesizes
proof from a commentary marker.

Each retirement evidence reference has exactly these keys:

```text
{ evidence_id, external_key, evidence_hash, evidence_document }
```

The document has exactly these keys:

```text
{
  manifest_revision_id, lane_id, run_id, merged_sha,
  evidence_kind, source_locator, observed_at, evidence_payload
}
```

`evidence_kind` is one of `merge_record`, `required_checks`,
`canonical_replay`, or `deterministic_validation`; `observed_at` is an ISO-8601
timestamp with a timezone and `evidence_payload` is an object. The hash is the
lowercase SHA-256 of UTF-8 canonical JSON (recursively sorted object keys,
compact separators, Unicode unescaped, and no non-finite numbers). Command
Center recomputes it, requires every scope field to equal the retirement
target, and permanently rejects replay of an evidence ID, external key, or
source locator across another revision, lane, run, or SHA.

The retirement packet must contain both an exact `merge_record` with
`evidence_payload.merged == true` and at least one successful validation
receipt. A `required_checks` receipt must have `all_green == true` with empty
`missing_required_checks` and `nonpassing_required_checks`; a
`deterministic_validation` receipt must have `passed == true`; a
`canonical_replay` receipt must have both `verified == true` and `passed == true` plus a non-empty
`verdict` or `receipt_summary`. Merge-only, failed, and empty packets are
rejected.

For `required_checks` and `merged_ci`, Command Center accepts only the exact
case-sensitive manifest allowlist, compared order-independently, with no
missing or non-passing required checks. Unrelated check failures are outside an
explicit allowlist; an empty allowlist retains the host aggregate result.
