import type { Context, MiddlewareFn } from "telegraf";

/**
 * Auth middleware: only allow messages from the configured owner.
 *
 * In a direct chat, matches on chat ID (OWNER_CHAT_ID).
 * In a supergroup (forum topics mode), also checks the sender's user ID
 * against OWNER_USER_ID so other group members are ignored.
 */
export function authGuard(
  ownerChatId: string,
  ownerUserId?: string
): MiddlewareFn<Context> {
  return (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    const userId = ctx.from?.id?.toString();
    const chatType = ctx.chat?.type;

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
