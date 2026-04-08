import type { Context, MiddlewareFn } from "telegraf";

interface AuthConfig {
  ownerChatId?: string;
  ownerUserId?: string;
}

/**
 * Auth middleware: only allow messages from the configured owner.
 *
 * In a direct chat, matches on chat ID (OWNER_CHAT_ID).
 * In a supergroup (forum topics mode), also checks the sender's user ID
 * against OWNER_USER_ID so other group members are ignored.
 */
export function authGuard(getConfig: () => AuthConfig): MiddlewareFn<Context> {
  return (ctx, next) => {
    const { ownerChatId = "", ownerUserId } = getConfig();
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    const chatType = ctx.chat?.type;
    const text = (ctx.message as any)?.text?.trim() ?? "";
    const callbackData = (ctx.callbackQuery as any)?.data ?? "";
    const isSetupCommand = /^\/(start|help|setup)\b/.test(text);
    const isSetupAction = typeof callbackData === "string" && callbackData.startsWith("setup:");
    const effectiveOwnerUserId =
      ownerUserId ??
      (ownerChatId && !ownerChatId.startsWith("-") ? ownerChatId : undefined);
    const isBootstrapSetupCommand =
      ownerChatId === "0" && (isSetupCommand || isSetupAction);
    const isOwnerSetupCommand =
      (isSetupCommand || isSetupAction) &&
      !!effectiveOwnerUserId &&
      userId === effectiveOwnerUserId;

    // Bootstrap mode: allow setup/help commands before IDs are configured.
    if (isBootstrapSetupCommand) {
      return next();
    }

    // Setup/help/start should also work for the configured owner in any chat
    // so they can discover a new group/supergroup ID without resetting config.
    if (isOwnerSetupCommand) {
      return next();
    }

    // Direct chat: match on chat ID only.
    if (chatType === "private" && chatId === ownerChatId) {
      return next();
    }

    // Group/supergroup: require the configured chat, and if supplied,
    // also require the configured owner user.
    if (chatId === ownerChatId && (!ownerUserId || userId === ownerUserId)) {
      return next();
    }

    console.log(
      `[auth] rejected chat=${chatId} user=${userId} (owner_chat=${ownerChatId} owner_user=${ownerUserId ?? "unset"})`
    );
    return;
  };
}
