# conductor-telegram
Control your conductor through Telegram!

## Setup

The bot supports two operating modes:

- Private chat mode: talk to the bot directly in a one-on-one chat.
- Forum topic mode: run the bot in a Telegram supergroup with Topics enabled so each workspace gets its own topic.

### Private chat mode

1. Create a bot with BotFather and copy the token into `BOT_TOKEN`.
2. Temporarily set `OWNER_CHAT_ID=0`.
3. Start the bot with `npm run dev`.
4. Open a direct chat with the bot and send `/start` or `/setup`.
5. The bot will reply with your current private chat ID and your Telegram user ID.
6. Set `OWNER_CHAT_ID` to that private chat ID.
7. Leave `OWNER_USER_ID` empty.
8. Restart the bot.

### Forum topic mode

Add the bot to your target group, make it admin, then run setup in that group.

1. Create a Telegram supergroup.
2. Enable `Topics` in the supergroup settings.
3. Add the bot to the supergroup.
4. Promote the bot to admin with permission to create/manage topics and send messages.
5. Temporarily set `OWNER_CHAT_ID=0` and `OWNER_USER_ID=0`.
6. Start the bot with `npm run dev`.
7. Send `/setup` in the target supergroup.
8. The bot will reply with the current supergroup chat ID and your Telegram user ID.
9. Set `OWNER_CHAT_ID` to the supergroup chat ID.
10. Set `OWNER_USER_ID` to your Telegram user ID.
11. Restart the bot.

New workspaces will create one forum topic per workspace automatically. If topic creation fails because the chat is not a forum or the bot lacks permissions, the bot falls back to normal chat messages.

### Bootstrap mode

When `OWNER_CHAT_ID=0`, the bot temporarily allows `/start`, `/help`, and `/setup` before auth is configured. This is the intended way to discover the correct IDs.
