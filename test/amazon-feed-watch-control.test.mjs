import assert from "node:assert/strict";
import test from "node:test";

import { finalizeAmazonFeedWatch, stopAmazonFeedWatches } from "../lib/amazon-feed-watch-control.js";

test("stops every persisted feed watch and clears its alarm", async () => {
  let persisted = null;
  let clearedAlarm = null;
  const result = await stopAmazonFeedWatches({
    storage: {
      get: async () => ({ amazonFeedWatches: { batchA: {}, batchB: {} } }),
      set: async (value) => { persisted = value; },
    },
    alarms: {
      clear: async (name) => {
        clearedAlarm = name;
        return true;
      },
    },
    watchesKey: "amazonFeedWatches",
    alarmName: "AMAZON_FEED_WATCH",
  });

  assert.deepEqual(persisted, { amazonFeedWatches: {} });
  assert.equal(clearedAlarm, "AMAZON_FEED_WATCH");
  assert.deepEqual(result, { watchesCleared: 2, alarmCleared: true });
});

test("closes a terminal dedicated feed tab while queuing an unacknowledged result", async () => {
  let persisted = null;
  let clearedAlarm = null;
  let closedTab = null;
  const watch = { batchId: "batch-1", createdDedicatedTab: true };
  const event = { batchId: "batch-1", status: "needs_review", failureReason: "Processing report unavailable" };

  const result = await finalizeAmazonFeedWatch({
    storage: {
      get: async () => ({ amazonFeedWatches: { "batch-1": watch }, amazonFeedTerminalEvents: {} }),
      set: async (value) => { persisted = value; },
    },
    alarms: { clear: async (name) => { clearedAlarm = name; return true; } },
    removeTab: async (tabId) => { closedTab = tabId; },
    watchesKey: "amazonFeedWatches",
    pendingEventsKey: "amazonFeedTerminalEvents",
    alarmName: "AMAZON_FEED_WATCH",
    watch,
    event,
    acknowledged: false,
    tabId: 42,
  });

  assert.deepEqual(persisted, {
    amazonFeedWatches: {},
    amazonFeedTerminalEvents: { "batch-1": { watch, event } },
  });
  assert.equal(clearedAlarm, "AMAZON_FEED_WATCH");
  assert.equal(closedTab, 42);
  assert.deepEqual(result, { queued: true, watchRemoved: true, tabClosed: true, alarmCleared: true });
});
