# Cloud workspace sync

## Product goal

Cloud workspace sync keeps Telegram useful as the shared conversation surface when work starts somewhere else. A workspace created in the Conductor app, through the API, or by another integration should appear in the chosen Telegram forum without asking the operator to recreate or manually route it.

The runtime implementation is available in cloud-only mode. The guided setup described below is the public onboarding contract for a follow-up release.

## Runtime behavior

Set `TELEGRAM_CLOUD_SYNC_CHAT_ID` to a negative Telegram supergroup ID. The group must have Topics enabled, the bot must be an administrator with Manage Topics, and `OWNER_USER_ID` must be set. The gateway validates all of these conditions before it starts.

Every minute, and whenever the owner runs `/sync`, the gateway reads the operator's unarchived Conductor Cloud workspaces. It excludes its own router workspace. A workspace is attached only when its canonical Git remote identifies exactly one accessible Conductor project. Missing or ambiguous identities fail closed and appear as sync failures in readiness health.

For each newly attached workspace, the gateway:

1. Creates one forum topic, or reuses the persisted topic after a restart.
2. Selects the working or most recently updated Conductor session as the default.
3. Records cursors at the existing transcript tail so history is not replayed.
4. Posts a connection note and the latest visible reply as context.
5. Forwards subsequent activity from every session into the same topic.

A reply to a forwarded Telegram message returns to that message's exact Conductor session. A plain topic message uses the selected session. `/threads` changes the selected session, and the gateway retains that session's native provider, model, and effort. Unsupported or unavailable model metadata is rejected instead of replaced with a guessed default.

Discovery is read-only in Conductor: it does not create, wake, stop, archive, or send work. Text, documents, photos, and transcribed voice become work only after an authenticated owner sends them in a topic that this gateway explicitly attached. Telegram topic service messages never become prompts.

Conductor workspace renames update the topic name. Archived or deleted workspaces close their topics while preserving Telegram history and the durable binding. The gateway does not take over existing repository launch topics.

## Coexistence and cutover

`TELEGRAM_CLOUD_SYNC_INPUT` controls input from the sync group:

- `commands` accepts only slash commands explicitly addressed to this bot, plus callbacks on this bot's buttons. Ordinary text and voice are not submitted or queued for later execution. Use this while another gateway still reads the group.
- `all` accepts owner text, media, voice, and commands in attached topics. This is the default for a single active gateway.

The setting cannot prevent another Telegram bot from processing a group message. During coexistence, operators should use only commands addressed to the new bot. Before switching to `all`, stop the previous consumer and verify it remains stopped. Then restart the new gateway, run `/sync@YourBot`, and test one reply to a forwarded message.

Commands-only mode is a cutover gate, not a running migration job. The gateway tells the sender when a message was not submitted. After cutover, check whether the previous bot already acted before resending anything. Command responses and human questions take priority over queued transcript updates while retaining Telegram rate-limit backoff and transcript order.

## Public guided setup

The public setup flow should remove the need to find and copy a numeric group ID:

1. The owner adds the bot to a supergroup, enables Topics, grants Manage Topics, and runs `/setup@YourBot` in that group.
2. The bot shows checks for forum mode, administrator status, Manage Topics, owner identity, Conductor organization access, and repository mappings.
3. An **Use for Cloud workspaces** action stores the chat as the sync destination without changing an existing private `OWNER_CHAT_ID`.
4. If the bot detects a migration or the operator chooses staged rollout, setup starts in commands-only mode and explains the one command used for validation.
5. An **Enable topic replies** action is available only after a fresh permission check and an explicit source-consumer checklist. It changes input to `all` and reports the effective state.

CLI setup should expose the same choices, persist `cloudSyncChatId` and `cloudSyncInput` in `config.json`, and render the equivalent environment variables for service deployments. `doctor`, `status`, `/ping`, and the readiness endpoint should report the configured group, current input mode, last successful scan, discovered and linked counts, failures, and missing permissions without exposing credentials.

## Acceptance criteria

- A workspace created outside Telegram appears once in the configured forum within 60 seconds, including when it starts asleep.
- Restarting the gateway creates no duplicate topic, transcript replay, or Conductor task.
- New messages from every Conductor session arrive; replying targets the original session after a restart.
- Only `OWNER_USER_ID` can submit work, and only inside topics created or attached by this gateway.
- Ambiguous repository identities, unknown models, missing sessions, permission loss, and API failures do not guess or create work.
- A rename updates the topic; archive or deletion closes it without deleting history.
- Commands-only migration mode prevents ordinary text, files, and voice from becoming tasks.
- More than 100 visible workspaces are discovered with bounded concurrency and without overlapping scans.
