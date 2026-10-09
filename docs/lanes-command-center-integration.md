# Command Center/Postgres lanes integration

The HTTP lane worker depends on the Command Center control plane for its
production ledger. The schema and transaction implementation are maintained in
the control-plane repository, not this worker repository:

- [Control-plane PR #427](https://github.com/belongnet/belong-agents/pull/427)
- [Pinned `conductor_lanes.py` implementation](https://github.com/belongnet/belong-agents/blob/2571748be708615e03eb54283aea2142b93fdf5c/belong-agent-center/backend/conductor_lanes.py)
- [Pinned PostgreSQL scenario](https://github.com/belongnet/belong-agents/blob/2571748be708615e03eb54283aea2142b93fdf5c/belong-agent-center/tests/postgres_conductor_lanes_scenario.py)
- [Pinned isolated HTTP/Postgres canary evidence](https://github.com/belongnet/belong-agents/pull/427#issuecomment-5592869350)
- [Control-plane PR #537](https://github.com/belongnet/belong-agents/pull/537), which adds check receipts and canonical CI evidence; this worker revision is checked against [`conductor_lanes.py` at c71ae7b](https://github.com/belongnet/belong-agents/blob/c71ae7b2ab430ee7bca6eb24618705d1530c36fc/belong-agent-center/backend/conductor_lanes.py)

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
Claude Sonnet, Codex GPT-5.6 Sol, or Cursor Grok 4.6 may commission only the
current provider primary (`fable-5-1`, `gpt-6-astra`, or `grok-4.7`) for this
exact human-authorized, globally paused validation run; it does not make a
retired model valid in a new manifest or any other attempt path.

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
timestamp with a timezone no more than five minutes in the future, and
`evidence_payload` is an object. The hash is the
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

For `required_checks` and `merged_ci` evidence of a lane with named
`required_checks`, Command Center accepts only that exact, case-sensitive list
with no missing or non-passing check: in manifest order for pre-merge
`required_checks`, in any order for `merged_ci`. Checks outside the list never
fail that evidence, though the Git host's own mergeability (GitHub's `UNSTABLE`,
for example) can still hold the merge. A lane without named checks uses the host's aggregate result, the
canonical host's when `canonical_evidence` is set.

### Check receipts and canonical CI evidence

Roll this contract out in order. A Command Center with #537 refuses check
evidence without receipts, which a worker older than this revision writes for
every lane with named checks; the old worker then pauses every lane. A Command
Center older than #537 refuses the new manifest fields. So run this worker
revision on every active OVH lease holder before any lane with
named checks runs against a #537 Command Center, and add `check_allowlist` or
`canonical_evidence` to the manifest only once both are in place.

Since [belong-agents #537](https://github.com/belongnet/belong-agents/pull/537),
a lane's `delivery_adapter` may also carry `check_allowlist` and
`canonical_evidence` (`{ kind, project_path, base_branch }`, where `kind` is
`github` or `gitlab`). `check_allowlist` names the checks a named-check receipt
may carry. It defaults to `required_checks` and must include every one of them,
so it constrains receipts. It does not filter the aggregate result of a lane
without named checks, as in Command Center. For these delivery fields the
worker refuses whatever Command Center would refuse (check names, blank values,
canonical projects), and also a GitHub canonical project that is not exactly
`owner/repository`. The same holds for the rest of a lane: blank or overlong
branches, titles, tags and command arguments, a validation script or package
path outside the repository, a probe URL that is not public (local names,
cloud metadata, private, loopback, link-local, reserved, multicast or
unspecified addresses, in every Python release's sense of those), and a
recurring schedule longer than a year.

For a lane with named required checks, the pre-merge `required_checks`
evidence is an exact receipt read from the canonical host for the exact head
commit: `source`, `project_path`, `base_branch`, `commit_sha`, a `pipeline_id`
(a positive number or a short string), and `checks`, one
`{ name, status: "success", commit_sha }` per required check in manifest
order. GitHub has no single pipeline, so its `pipeline_id` names the check
runs and commit statuses behind the result, such as `github-status-81`.
Summary-only evidence is rejected.

A lane with `canonical_evidence` is proven by that host and project only, for
both the pre-merge gate and merged-SHA CI, and a green GitHub mirror never
counts. On GitLab the worker reads the newest pipeline the project's own CI ran
for the exact commit, pinned to the reviewed head branch before merge and the
canonical base branch after merge. A same-commit pipeline on another branch
cannot stand in for it. The canonical project must run CI for the reviewed
branch; otherwise the gate waits. Only a push or merge-request pipeline counts (source `push`,
`merge_request_event` or `external_pull_request_event`). An external pipeline
only holds commit statuses, a child pipeline is a slice of its parent, and a
pipeline started by hand, by API, trigger or schedule can carry variables that
skip jobs. None of these count. The pipeline list does not say whether a
pipeline ran for a tag, so the worker reads each candidate in full and skips
tag pipelines; past ten of them on one commit the gate waits.
Even a push pipeline can carry variables supplied through Git push options.
The worker checks the pipeline's supplied variables and holds the gate if any
are present. It never includes their names or values in a receipt or alert.

GitLab's own verdict on a pipeline is not enough on its own. Anyone with
Developer access can post a commit status under a job's name, which retires
that job and can turn a red pipeline green. So the worker also reads the last
run of every job, retried runs and bridges to downstream pipelines included.
Without named checks a pipeline passes only when GitLab says it succeeded and
every job's last run agrees. A job agrees when it succeeded or was skipped, or
when it is allowed to fail and failed, was canceled or waits on a manual start.
A failed job or pipeline holds the pre-merge gate and asks for a repair after
the merge. Anything still running, canceled, skipped or manual holds the gate,
and so does a green pipeline with no jobs. With named checks, those jobs' last
runs alone decide, each only on its own success, and the rest of the pipeline
is not consulted. A GitLab-delivered lane with named checks is proven the same
way, from its own project's newest pipeline, rather than from commit statuses
as before. Jobs inside downstream pipelines and external statuses therefore no
longer satisfy a named check, though the bridge job that starts a downstream
pipeline does. Green checks that cannot be tied to a pipeline hold the gate
instead of merging.

A lane with neither named checks nor canonical evidence keeps the Git host's
aggregate result. On its merged commit, checks that are missing or still
running hold validation, and red checks ask for a repair; neither pauses the
other lanes.

A GitLab-proven lane needs `GITLAB_TOKEN`, even when it delivers through
GitHub: read API access is enough for canonical evidence, while a
GitLab-delivered lane also posts merge-request notes and merges, which needs
the `api` scope. The worker refuses to start without the token. For each such
project, `doctor` checks pipeline listing and, if one exists, reads that
pipeline's variables endpoint; it does not check write scope. A project with
no pipelines leaves variables-endpoint access untested until the worker reads
its first pipeline.

Command Center counts merge evidence as fresh for 5 minutes (merged-SHA CI for
15) from when a row is first written, and answers a repeated key with that
original row. The worker keys check, mergeability and merged-SHA CI evidence to
a 4-minute window, and records the pre-merge evidence again just before it
merges. A result that stays green while the merge waits on something else
therefore never ages out.

#### When CI never decides

A check gate waits as long as CI does. That suits slow CI, but not CI that
never decides: a commit that never reached the canonical project (a broken
mirror), no runner picking up its jobs, a job blocked on a manual start, or a
repository whose CI never runs on its base branch. Once a gate has seen the
same commit undecided, neither passing nor failed, for an hour, the worker
sends one Telegram alert naming the lane, the CI project and the commit. That
covers the pull request head and merged commit of an exact-receipt lane, and
the merged commit of a lane without named checks. The gate keeps waiting.
The hour is counted by the worker holding the lease and restarts with it, so
after a restart or failover the alert can take up to an hour longer. Command Center's notification key keeps it to one alert per run,
phase and commit. A pull request that cannot merge is not read at all, since
its receipt waits until it could merge, so it raises no alert. A missing
commit is alerted on only for GitLab, which answers with no pipeline. A GitHub
canonical repository that lacks the commit answers the checks read with an
error instead, and the worker restarts, as on any Git-host error, until the
commit arrives.

To act on the alert, check that the commit exists in the canonical project and
that a push or merge-request pipeline ran for it
(`GET /projects/:id/pipelines?sha=<commit>`). A pipeline started by hand, API,
trigger or schedule does not count, nor does one for a tag. Run the pipeline
the way the project's CI expects, or fix the runner. A merged commit that a
mirror pushed together with newer ones never gets a branch pipeline of its own,
because GitLab runs one only for the newest commit of a push. Hold that lane,
then retire its merged run with `conductor-telegram lanes retire` once the
change is verified another way. To stop any lane instead, hold it with
`conductor-telegram lanes hold <lane> --reason "..."`.
