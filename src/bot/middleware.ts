import type { Context, MiddlewareFn } from "telegraf";

/**
 * Auth middleware: only allow messages from the configured owner chat ID.
 * Silently ignores all other messages.
 */
export function authGuard(ownerChatId: string): MiddlewareFn<Context> {
  return (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    console.log(`[auth] message from chat=${chatId} owner=${ownerChatId} match=${chatId === ownerChatId}`);
    if (chatId !== ownerChatId) {
      console.log(`[auth] rejected chat ${chatId}`);
      return;
    }
    return next();
  };
}
