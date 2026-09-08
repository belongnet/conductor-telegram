# Command Center/Postgres lanes integration

The HTTP lane worker depends on the Command Center control plane for its
production ledger. The schema and transaction implementation are maintained in
the control-plane repository, not this worker repository:

- [Control-plane PR #427](https://github.com/belongnet/belong-agents/pull/427)
- [Pinned `conductor_lanes.py` implementation](https://github.com/belongnet/belong-agents/blob/2571748be708615e03eb54283aea2142b93fdf5c/belong-agent-center/backend/conductor_lanes.py)
- [Pinned PostgreSQL scenario](https://github.com/belongnet/belong-agents/blob/2571748be708615e03eb54283aea2142b93fdf5c/belong-agent-center/tests/postgres_conductor_lanes_scenario.py)

That pinned implementation defines the deployed `conductor_lane_runs` and
`conductor_lane_actions` tables in `PG_SCHEMA`. Its `finish_action` transaction
rejects every transition from `ambiguous` except authoritative `reconciled`,
and preserves `ambiguous_action_id` when an unrelated action finishes. The
scenario runs against an isolated PostgreSQL schema and exercises those
invariants through the control-plane store; CI supplies `TEST_POSTGRES_URL`.

Before enabling the HTTP worker, land the control-plane PR (or a newer commit
with the same contract), run its PostgreSQL scenario, and point
`COMMAND_CENTER_API_BASE_URL` at that deployment. This worker repository does
not silently apply SQL to the control plane and keeps production prepare-only.
