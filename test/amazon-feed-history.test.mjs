import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAmazonFeedDoneEvent,
  findNewAmazonFeedRow,
  nextAmazonFeedWatchState,
  parseAmazonProcessingReport,
  shouldRefreshAmazonFeedHistory,
} from "../lib/amazon-feed-history.js";

test("reloads only a dedicated feed tab when an alarm polls it", () => {
  assert.equal(shouldRefreshAmazonFeedHistory({ createdDedicatedTab: true }, "alarm"), true);
  assert.equal(shouldRefreshAmazonFeedHistory({ createdDedicatedTab: true }, "initial"), false);
  assert.equal(shouldRefreshAmazonFeedHistory({ createdDedicatedTab: false }, "alarm"), false);
});

test("selects the upload-history row that did not exist before submission", () => {
  const row = findNewAmazonFeedRow({
    beforeBatchIds: ["93613020711"],
    rows: [
      { amazonBatchId: "93703020720", status: "Done", reportHref: "/report/93703020720" },
      { amazonBatchId: "93613020711", status: "Done" },
    ],
  });

  assert.deepEqual(row, {
    amazonBatchId: "93703020720",
    status: "done",
    reportHref: "/report/93703020720",
  });
});

test("parses Amazon Processing Report counters", () => {
  const result = parseAmazonProcessingReport(`Status: Done
Number of records processed from this upload: 1
Number of records that were activated: 1
Number of records with errors: 0
Number of records with warnings: 0`);

  assert.deepEqual(result, {
    status: "done",
    recordsProcessed: 1,
    recordsActivated: 1,
    errorCount: 0,
    warningCount: 0,
  });
});

test("treats Amazon's successful counter as activated records", () => {
  const result = parseAmazonProcessingReport(`Feed Processing Summary:
	Number of records processed		2
	Number of records successful		2
`);

  assert.deepEqual(result, {
    status: "submitted",
    recordsProcessed: 2,
    recordsActivated: 2,
    errorCount: 0,
    warningCount: 0,
  });
});

test("uses the history row as Done even when the downloaded report omits Status", () => {
  const event = buildAmazonFeedDoneEvent({
    batchId: "batch-1",
    amazonBatchId: "93703020720",
    reportText: "Number of records processed from this upload: 1\nNumber of records that were activated: 1\nNumber of records with errors: 0\nNumber of records with warnings: 0",
  });

  assert.equal(event.status, "done");
  assert.equal(event.recordsActivated, 1);
});

test("preserves a resumed watch as polling-only", () => {
  const next = nextAmazonFeedWatchState({
    batchId: "batch-1",
    amazonBatchId: "93703020720",
    expectedRows: 1,
  }, { amazonBatchId: "93703020720", status: "In Progress" });

  assert.equal(next.action, "poll");
  assert.equal(next.status, "processing");
});

test("stops only after a terminal status is acknowledged", () => {
  const next = nextAmazonFeedWatchState({ batchId: "batch-1", expectedRows: 1 }, {
    amazonBatchId: "93703020720",
    status: "Done",
  });

  assert.equal(next.action, "fetch_report");
  assert.equal(next.terminal, false);
});
