import assert from "node:assert/strict";
import test from "node:test";
import { missingLaneWorkerAlertConfig } from "../src/lanes/worker.js";

test("every lease worker requires send-only Telegram alert credentials", () => {
  assert.deepEqual(missingLaneWorkerAlertConfig({}), [
    "BOT_TOKEN",
    "OWNER_CHAT_ID",
  ]);
  assert.deepEqual(
    missingLaneWorkerAlertConfig({ BOT_TOKEN: "token", OWNER_CHAT_ID: "123" }),
    []
  );
  assert.deepEqual(
    missingLaneWorkerAlertConfig({ BOT_TOKEN: "  ", OWNER_CHAT_ID: "123" }),
    ["BOT_TOKEN"]
  );
});
