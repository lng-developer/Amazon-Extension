import assert from "node:assert/strict";
import test from "node:test";

import { buildAmazonFeedResult, upsertAmazonFeedResult } from "../lib/amazon-feed-results.js";

test("records Amazon's terminal counters and backend sync state", () => {
  const result = buildAmazonFeedResult({
    watch: { batchId: "batch-1", expectedRows: 2 },
    event: {
      amazonBatchId: "93703020720",
      status: "done",
      recordsProcessed: 2,
      recordsActivated: 2,
      errorCount: 0,
      warningCount: 1,
    },
    ack: { ok: true, terminal: true, status: "done" },
    at: 123,
  });

  assert.deepEqual(result, {
    batchId: "batch-1",
    amazonBatchId: "93703020720",
    amazonStatus: "done",
    backendStatus: "done",
    expectedRows: 2,
    recordsProcessed: 2,
    recordsActivated: 2,
    errorCount: 0,
    warningCount: 1,
    failureReason: "",
    at: 123,
  });
});

test("updates a batch result instead of duplicating it when backend sync completes", () => {
  const current = [{ batchId: "batch-1", backendStatus: "pending_sync", at: 100 }, { batchId: "batch-2", at: 99 }];
  const next = upsertAmazonFeedResult(current, { batchId: "batch-1", backendStatus: "done", at: 123 });

  assert.deepEqual(next, [
    { batchId: "batch-1", backendStatus: "done", at: 123 },
    { batchId: "batch-2", at: 99 },
  ]);
});
