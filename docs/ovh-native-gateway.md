# OVH native Conductor gateway

`TELEGRAM_RUNTIME_MODE=cloud-only` runs Telegram on OVH and uses the official Conductor API for every agent operation. `hybrid` remains the default for existing installations. Cloud mode requires an organization API key and does not fall back to desktop SQLite, local checkouts, or model CLIs.

The gateway keeps the existing history database and adds durable input, output, native identity, file, and recovery tables. Incoming updates and the next Telegram offset commit together. Work is ordered within each conversation; media and native execution run separately. `/ping` has an independent read-only path. Four independent workers poll active cloud sessions every 15 seconds and idle sessions every 60 seconds, including workspaces beyond the old 100-record limit.

Telegram 429 responses persist `retry_after` across restarts. Command responses and human questions take priority over queued transcript updates while preserving transcript order. Messages take priority over topic edits, redundant edits coalesce, unchanged topics succeed, and deleted topics are recreated. Questions acquire a durable `(chat ID, message ID)` association when delivery commits. Delivery receipts prevent replay of recorded chunks. Telegram does not offer client message IDs: a send accepted by Telegram whose response is lost can be duplicated on retry. Native Conductor sends retain the original message ID and exact text, allowing reconciliation without repeating work.

## Existing cloud workspaces and topic replies

Set `TELEGRAM_CLOUD_SYNC_CHAT_ID` to the forum group ID to discover existing cloud workspaces every minute. The bot needs administrator access with Manage Topics, and `OWNER_USER_ID` must identify the person permitted to send commands. `/sync` requests an immediate refresh. `OWNER_CHAT_ID` may remain the owner's private chat; the extra group accepts input only inside topics explicitly attached by this gateway.

Discovery matches canonical repository remotes to Conductor projects and creates one topic per native workspace, including sleeping workspaces. It preserves existing sessions and models, sends the selected session's latest visible reply once, and forwards new replies from every session. It does not launch, wake, stop, or replay existing work. The default thread is the working or most recently updated session; `/threads` selects another. Replying to a forwarded message targets that exact session, including after a gateway restart. Unknown model settings or ambiguous repository mappings require reconciliation.

Text and voice replies use the same targeting. Voice is downloaded privately, converted with FFmpeg and transcribed with Whisper in the separate media worker; Conductor receives the resulting text. A failed transcription never submits an empty task. Topic service events do not become prompts, and commands addressed to other bots are ignored. When Conductor archives or deletes a workspace, its topic closes and its history remains. Existing repository topics are retained. During migration, `TELEGRAM_CLOUD_SYNC_INPUT=commands` permits only commands explicitly addressed to this bot in the sync group, plus its own button callbacks. Set it to `all` (the default) after disabling the previous gateway's consumer to enable ordinary text and voice replies. This setting does not stop another bot from processing messages; do not send plain text or voice into a shared group while its old consumer remains active.

Commands-only mode reports when a message was not submitted; it does not queue that message for execution after cutover. Check whether the previous bot already acted before resending. See [Cloud workspace sync](cloud-workspace-sync.md#coexistence-and-cutover) for the cutover sequence.

## Native tasks, reviews, and recovery

Use `/projects` or `/repos`, `/run <project ID> <task>`, `/send`, topic messages, or replies to forwarded messages. `/threads new <prompt>` creates a native session; `/threads` selects one. `/fleet` uses the native read-only transcript view. `/lanes` retains the existing HTTP controls and human approval checks; its independently supervised worker owns orchestration, ordering, capacity, and merge gates.

Preserved local workspaces without a Conductor Cloud session keep their history. Task messages and commands such as `/send`, `/stop`, and `/review` targeting that history receive a notice that no work was submitted. Use `/repos`, then `/run <project ID> <task>` to start new work; the new task does not inherit the historical session.

The AI router uses a dedicated native workspace/session, serialized requests, validated target IDs, and owner confirmation before work begins. Configure its project with `TELEGRAM_CLOUD_ROUTER_PROJECT_ID`. Repository topics must map to a verified canonical Git remote and project ID; historical Mac basenames never authorize a destination.

`TELEGRAM_CLOUD_REVIEW_POLICY=native` enables `/review <GitHub PR URL>`. Reviews use a separate session and a provider different from the task author. Existing `TELEGRAM_REVIEW_AGENT_TYPE` and `TELEGRAM_REVIEW_MODEL` settings are honored; an unavailable or same-author reviewer is rejected before execution. They receive findings-only instructions with normal Conductor permissions. They are bound to the exact head and base commits; subsequent changes invalidate completion. No completion notice creates a merge intent, approval, or authorization to bypass checks. The independent lanes worker retains its existing merge checks.

Recovery reconciles transcript, workspace lifecycle, and session status. A terminal disconnection first gets one continuation in the same session. Provider exhaustion (including depleted usage credits), unavailable or inaccessible models, and repeated disconnects advance through the configured primary, then Claude `fable-5-1`, Codex `gpt-5.6-sol`, and Cursor `grok-4.6`, omitting disabled/attempted providers. `TELEGRAM_CLOUD_PROVIDERS` must list only configured providers and include the primary. Each task/review has a separate persisted recovery episode. A replacement rechecks that its predecessor is still failed before it starts. Uncertain workspace/session creation is reconciled by its recorded identity and never blindly repeated. User-stopped tasks remain stopped; start a new `/run` to resume deliberately.

Conductor workspaces can sleep and have a maximum lifetime of 23 hours 50 minutes. Files survive workspace sleep, processes do not. A sleeping interrupted task receives a continuation after reconciliation. Archived/deleted workspaces and ambiguous mutations require attention instead of automatic replay. See [Conductor workspace lifecycle](https://www.conductor.build/docs/cloud/working-with-cloud-workspaces).

## Release and prerequisites

Use your approved OVH host. The image pins Node 22 and Whisper, verifies the model checksum, and contains FFmpeg; it does not depend on the host Node version.

```sh
docker build --target checks -f packaging/cloud/Dockerfile -t conductor-telegram:native-checks .
docker build --target runtime -f packaging/cloud/Dockerfile -t conductor-telegram:native-candidate .
docker image inspect conductor-telegram:native-candidate --format '{{.Id}}'
```

Use the resulting immutable image ID in `/etc/conductor-telegram/release.env` as `GATEWAY_IMAGE=sha256:...`. Preserve the previous image and release file. Do not use an auto-moving tag for the service.

The production environment belongs in `/etc/conductor-telegram/gateway.env`, root-owned mode `0600`; use [gateway.env.example](../packaging/cloud/gateway.env.example). Required: production bot token and owner IDs, Conductor organization API key, GitHub token, approved HTTPS bridge origin, configured provider credentials in Conductor, and access to stop all source-host consumers. The gateway refuses to start if a Telegram webhook remains configured. Never run it with the production token while the previous gateway is polling.

Install [the gateway unit](../packaging/systemd/conductor-telegram-gateway.service), backup and watchdog units/timers into `/etc/systemd/system`. Install `scripts/cloud/watchdog.sh` at `/opt/conductor-telegram/scripts/cloud/watchdog.sh`. Create `/var/lib/conductor-telegram` with owner UID/GID `10001:10001` and mode `0700`, and run `systemctl daemon-reload`. Preparing units does not require starting them.

The service binds the bridge to `127.0.0.1:8787`. Merge the supplied [Caddy site](../packaging/cloud/Caddyfile) into the approved HTTPS proxy; preserve existing sites. Do not log signed attachment URLs. Expose only HTTPS externally. The bridge serves private, expiring, file-specific downloads; uploads, event reports, and decision reads require a workspace-scoped token. It never shares SQLite or Telegram download URLs with cloud agents.

If durable lanes are already enabled, retain their manifest and HTTP state and use [the separate container unit](../packaging/cloud/conductor-telegram-lanes.service). Keep human-approval credentials in the gateway for explicit owner controls; exclude them from the worker environment. Do not enable a previously disabled controller or change its cutover revision as part of moving Telegram.

## Cloud MCP setup

The cloud workspace receives only `TELEGRAM_BRIDGE_URL`, a scoped `TELEGRAM_BRIDGE_TOKEN`, and its tracked workspace ID. In Conductor's organization cloud setup command, run this after the normal repository setup:

```sh
node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if (process.env.TELEGRAM_BRIDGE_URL && process.env.TELEGRAM_BRIDGE_TOKEN) {
  const origin = new URL(process.env.TELEGRAM_BRIDGE_URL);
  if (origin.protocol !== 'https:') throw new Error('HTTPS required');
  const response = await fetch(`${origin.origin}/v1/bootstrap`, {
    headers: {Authorization: `Bearer ${process.env.TELEGRAM_BRIDGE_TOKEN}`},
    redirect: 'error', signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Telegram setup failed (${response.status})`);
  writeFileSync('/tmp/setup-telegram-mcp.sh', await response.text(), {mode: 0o700});
  execFileSync('bash', ['/tmp/setup-telegram-mcp.sh'], {stdio: 'inherit'});
}
JS
```

The setup downloads the release client through the authenticated bridge and configures user-level MCP settings for Claude, Codex, and Cursor, leaving repository files alone. Verify tools in all configured providers before cutover. Tools: `report_status`, `report_artifact`, `request_human`, `read_human_decision`, `list_human_decisions`, and `refresh_attachment`. Questions survive gateway restarts; after a tool timeout or agent reconnect, read the existing decision ID. A timeout is never approval.

## Isolated acceptance

Start the candidate with a **separate test bot**, separate owner chat, a fresh state directory mounted at `/var/lib/conductor-telegram`, and a separate HTTPS test origin/port. Use the release image for `doctor --no-color`; cloud doctor checks native identity/project access, Telegram identity, GitHub authentication, bridge HTTPS, and media prerequisites. It does not certify provider execution.

The optional [test service](../packaging/cloud/conductor-telegram-test.service) uses `/etc/conductor-telegram/test.env`, a pinned image in `test-release.env`, separate state at `/var/lib/conductor-telegram-test`, and loopback port `8788`. Create its state directory with owner `10001:10001` and mode `0700`; keep environment files root-owned and mode `0600`. Installing the unit does not start it. Confirm that `getMe` identifies the separate test bot before starting, and proxy the approved test HTTPS origin to port `8788`.

In the test owner chat, verify:

1. `/ping` and `/run <test project> <task>` receive acknowledgements within five seconds under healthy upstream conditions.
2. The task reports progress, uses `request_human`, waits, consumes the owner's reply, and returns a final answer. Reply to a question after restarting the gateway as well.
3. Voice notes transcribe; photo/document captions reach the agent; an agent-created file comes back to Telegram. Refresh an expired link. Another workspace's credential must receive no file or decision data.
4. `/review <test PR URL>` creates a separate thread. Change the head commit and verify previous completion becomes invalid. Review completion cannot grant merge approval.
5. Interrupt a provider; reconcile and resume the same session, then test exhaustion/fallback. Verify only one task continues. Test explicit stop during launch/recovery; it must remain stopped.
6. Restart the gateway while updates and outgoing chunks are pending. Verify ordered delivery, persistent question links, and no duplicate native work. Exercise all configured providers and the router's confirmation step.

Run `node scripts/cloud/soak.mjs https://TEST_ORIGIN 24 evidence.jsonl` after the acceptance flow. `/health/live` measures local process liveness. `/health/ready` reports ingestion age, Conductor access/polling, stalled workspaces, and delivery backlog. Queue latency samples measure gateway delivery time only; separately time the real owner command and Conductor transcript to verify five-second acknowledgements and 30-second forwarding. A 24-hour HTTP soak alone does not prove those end-to-end targets.

## Migration and cutover

`scripts/cloud/state.py` works on both hosts with Python 3. It uses SQLite backup and hashes every table's rows and every copied file. Destinations must be new directories; existing state is never overwritten.

```sh
python3 scripts/cloud/state.py backup --db SOURCE_DB --files SOURCE_DOWNLOADS --out NEW_SNAPSHOT
python3 scripts/cloud/state.py verify NEW_SNAPSHOT
python3 scripts/cloud/state.py migrate --snapshot NEW_SNAPSHOT --out NEW_RELEASE_STATE --identities verified-identities.json
```

The identity file has `repositories: [{path, remote, verifiedBy: "git-remote"}]` from actual source `git remote get-url origin` reads, and `projects: [{id, name, gitRemote}]` from the authenticated Conductor API. Only unique full-remote matches map repository topics. The report lists unresolved topics, native bindings, and creation intents. Preserve unresolved historical workspaces; never guess a cloud destination. Existing native message IDs, cursors, queued updates, decisions, and pending operations remain in the database. Verified legacy outboxes retain original message IDs/text during adoption. Unresolved creation intents block replay and need reconciliation.

After test acceptance, provider checks, HTTPS reachability, and migration rehearsal all pass:

1. Record the source service inventory and current release. On the source Mac, as the gateway service owner/admin, create `~/.conductor-telegram/bot-stopped`, then disable and boot out the installed updater, watchdog, and gateway LaunchAgents. Read their exact labels from the source service inventory. Verify all three remain unloaded and no Telegram poller process remains. Preserve the plists and old release. Do not stop an independent lanes worker unless its own approved migration requires it.
2. Take the **final** consistent database/download backup after those stops. Transfer and verify it on OVH; repeat migration with the verified project catalog. The prior live audit is not a final cutover backup.
3. Install the migrated state at `/var/lib/conductor-telegram` with its original data intact and UID/GID `10001:10001`. Native attachment references use this stable container mount. Keep the original snapshot separately.
4. Confirm source absence once more; then start only the OVH gateway. Do not call `deleteWebhook(drop_pending_updates=true)` or discard updates. The gateway resumes its persisted offset, and any unacknowledged Telegram updates are ingested normally.
5. Verify production bot identity, ready health, pending questions, owner round trip, PR review, and attachment exchange. Enable the gateway service and backup/watchdog timers only after verification. Start the 24-hour production soak and retain its evidence.

## Rollback

First stop and disable the OVH watchdog timer, stop the OVH gateway, and verify its container/poller is gone. Take and verify a fresh backup of **the current OVH database and attachments**, including every update received since cutover. Retain this snapshot regardless of the rollback path.

Prefer reverting the image on OVH while keeping the newest state. A release must understand the durable cloud queues to consume them safely. The old v0.8.0 hybrid binary cannot consume the new queues: do not start it against a stale pre-cutover database. If host rollback is necessary, transfer the newest state and run a compatible cloud-only release on the previous host; update the bridge origin and scoped workspace access before resuming. Uncertain mutations require reconciliation, not replay. Re-enable exactly one Telegram consumer only after the newest state is verified on the chosen host. Keep the other host stopped.

The Docker log driver retains three 10 MB files per container; systemd output is also subject to the host journal policy. Daily backups retain seven verified snapshots. Attachments and message history are retained; monitor available disk space. OVH, Telegram, Conductor, and provider outages remain dependencies, so absolute uninterrupted uptime is not promised.
