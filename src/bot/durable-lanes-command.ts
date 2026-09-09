import type { Context } from "telegraf";
import { randomUUID } from "node:crypto";
import { escHtml, truncateHtml, TELEGRAM_MAX_TEXT } from "./format.js";

export async function handleDurableLanes(ctx: Context, rawArg: string): Promise<void> {
  const { createLaneStateStore } = await import("../lanes/state-store.js");
  const { deterministicLaneId } = await import("../lanes/controller-policy.js");
  const store = await createLaneStateStore();
  try {
    const [subcommand = "", first] = rawArg.split(/\s+/, 2);
    const command = subcommand.toLowerCase();
    const controls: Record<
      string,
      { kind: string; laneId?: string; payload?: Record<string, unknown>; human?: boolean }
    > = {
      pause: { kind: "pause" },
      resume: { kind: "resume" },
      retry: { kind: "retry", laneId: first },
      "provider-disable": {
        kind: "provider_disable",
        payload: { provider: first },
      },
      "provider-enable": {
        kind: "provider_enable",
        payload: { provider: first },
      },
      "archive-approval": {
        kind: "archive_approval",
        payload: { batch: "legacy-untagged" },
        human: true,
      },
      cutover: {
        kind: "cutover",
        payload: { revision_id: first },
        human: true,
      },
      shadow: {
        kind: "shadow",
        payload: { revision_id: first },
      },
      rollback: { kind: "rollback", human: true },
    };
    if (command === "run" || command === "reconcile") {
      await ctx.reply(
        "The fenced lanes worker reconciles independently of Telegram and will poll within 30 seconds."
      );
      return;
    }
    if (command) {
      const control = controls[command];
      if (!control) {
        await ctx.reply(
          "Usage: /lanes — status\n/lanes shadow <revision>\n/lanes pause|resume\n/lanes retry <lane>\n/lanes provider-disable|provider-enable <claude|codex|cursor>\n/lanes archive-approval batch\n/lanes cutover <revision>\n/lanes rollback"
        );
        return;
      }
      if (
        (["retry", "archive-approval", "shadow", "cutover", "provider-disable", "provider-enable"].includes(command) &&
          !first)
      ) {
        await ctx.reply(`Usage: /lanes ${command} <value>`);
        return;
      }
      if (
        ["provider-disable", "provider-enable"].includes(command) &&
        !["claude", "codex", "cursor"].includes(first)
      ) {
        await ctx.reply("Provider must be claude, codex, or cursor.");
        return;
      }
      if (command === "archive-approval") {
        if (first !== "batch") {
          await ctx.reply("Usage: /lanes archive-approval batch");
          return;
        }
        const snapshot = await store.snapshot();
        const eligible = snapshot.runs.filter((run) => {
          if (!run.workspace_id || run.legacy_verified) return false;
          const name = String(run.workspace_name ?? "");
          const managed = [
            "[managed:growth]",
            `[lane:${run.lane_id}]`,
            `[run:${run.run_id}]`,
          ].every((tag) => name.includes(tag));
          return (
            !managed
          );
        });
        const workspaceIds = eligible.map((run) => run.workspace_id!).sort();
        if (workspaceIds.length === 0) {
          await ctx.reply("No matching untagged legacy workspaces need approval.");
          return;
        }
        control.payload = {
          batch: "legacy-untagged",
          workspace_ids: workspaceIds,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
      }
      const messageId = String((ctx.message as any)?.message_id ?? randomUUID());
      const actor = `telegram:${ctx.from?.id ?? "owner"}`;
      const idempotencyKey = `telegram:${ctx.chat?.id ?? "owner"}:${messageId}:${command}`;
      const created = await store.createControl({
        control_id: deterministicLaneId("control", idempotencyKey),
        idempotency_key: idempotencyKey,
        kind: control.kind,
        lane_id: control.laneId,
        requested_by: actor,
        payload: control.payload,
        approvalKey: control.human
          ? process.env.BELONG_HUMAN_APPROVAL_KEY?.trim()
          : undefined,
      });
      await ctx.reply(
        `Lane control queued: ${created.kind}${created.lane_id ? ` ${created.lane_id}` : ""}. The lease holder will apply it.`
      );
      return;
    }

    const snapshot = await store.snapshot();
    const capacity = Object.entries(snapshot.capacity)
      .map(([provider, value]) => `${provider} ${value.active}/${value.limit}`)
      .join(" · ");
    const lease = snapshot.lease as Record<string, unknown> | null;
    const leaseLine = lease?.held !== false && lease?.owner_id
      ? `${lease.owner_site ?? "?"}/${lease.owner_id ?? "?"} · heartbeat ${lease.heartbeat_age_seconds ?? "?"}s · fence ${lease.fence ?? "?"}`
      : `unclaimed${lease?.last_owner_site ? ` · last ${lease.last_owner_site}` : ""}`;
    const providers = snapshot.providers
      .filter((provider) => provider.state !== "healthy")
      .map((provider) => `${provider.provider}:${provider.state}`)
      .join(", ");
    const lanes = snapshot.runs
      .sort((left, right) => right.priority - left.priority)
      .map(
        (run) =>
          `<code>${escHtml(run.lane_id)}</code> g${run.generation} · ${escHtml(run.status)}/${escHtml(run.stage)} · ${escHtml(run.provider ?? "—")}` +
          `${run.pr_url ? `\n  ${escHtml(run.pr_url)} @ ${escHtml((run.head_sha ?? "").slice(0, 10))}` : ""}` +
          `${run.ambiguous_action_id ? `\n  ⚠ ambiguous ${escHtml(run.ambiguous_action_id)}` : ""}`
      );
    const archiveApprovals = snapshot.runs.filter((run) => {
      if (!run.workspace_id || run.legacy_verified) return false;
      const name = String(run.workspace_name ?? "");
      const managed = [
        "[managed:growth]",
        `[lane:${run.lane_id}]`,
        `[run:${run.run_id}]`,
      ].every((tag) => name.includes(tag));
      const approvedUntil = Date.parse(
        String(run.metadata_json.archive_approved_until ?? "")
      );
      const exactApproval =
        run.metadata_json.archive_approved_workspace_id === run.workspace_id &&
        Number.isFinite(approvedUntil) &&
        approvedUntil > Date.now();
      return !managed && !exactApproval;
    }).length;
    const body =
      `<b>Durable lanes · ${escHtml(snapshot.controller?.mode ?? "disabled")}</b>\n` +
      `${escHtml(capacity)}\nLease: ${escHtml(leaseLine)}` +
      `${providers ? `\nBreakers: ${escHtml(providers)}` : ""}` +
      `\nAmbiguous: ${snapshot.ambiguous_actions.length} · duplicates: ${snapshot.duplicates.length} · approvals: ${snapshot.pending_controls.filter((control) => control.human_approved).length + archiveApprovals}` +
      `${lanes.length ? `\n\n${lanes.join("\n\n")}` : "\n\nNo durable lane runs."}`;
    await ctx.reply(truncateHtml(body, TELEGRAM_MAX_TEXT), { parse_mode: "HTML" });
  } finally {
    await store.close();
  }
}
