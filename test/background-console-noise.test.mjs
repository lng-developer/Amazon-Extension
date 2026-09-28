import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

test("socket success and retry traces do not flood the service-worker console", () => {
  for (const message of [
    "connectSocketIO entered",
    "Starting socket connection...",
    "Creating new socket connection",
    "Connected successfully",
    "Reconnection attempt",
  ]) {
    assert.doesNotMatch(source, new RegExp(`console\\.log\\([^\\n]*${message.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`));
  }
});

test("tracking task never prints its complete payload to the console", () => {
  assert.doesNotMatch(source, /UPLOAD_TRACKING payload details/);
  assert.doesNotMatch(source, /Task that caused error/);
  assert.doesNotMatch(source, /Content length:/);
});

test("routine task receipt and acknowledgement traces stay out of the console", () => {
  assert.doesNotMatch(source, /console\.log\([^\n]*\[TASK_REPLY\]/);
  assert.doesNotMatch(source, /console\.log\([^\n]*Handling IMPORT_FBM_ORDERS/);
  assert.doesNotMatch(source, /console\.log\([^\n]*Handling IMPORT_ORDERS/);
  assert.doesNotMatch(source, /console\.log\([^\n]*Handling IMPORT_ADS_SPEND/);
  assert.doesNotMatch(source, /console\.log\([^\n]*Ads spend range:/);
});

test("connection and task failures remain visible for diagnosis", () => {
  assert.match(source, /\[SOCKET-LOG\] connect_error/);
  assert.match(source, /\[UPLOAD_TRACKING\] Amazon feed watch poll failed/);
  assert.match(source, /logTaskFailed/);
});
