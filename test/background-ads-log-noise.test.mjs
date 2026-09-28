import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

test("Ads lock acquisition and header capture do not enter the runtime log", () => {
  assert.doesNotMatch(source, /log\(`\[ADS-LOCK\] Acquired/);
  assert.doesNotMatch(source, /log\("\[ADS\] headers captured:/);
});

test("Ads failures and final import outcome remain auditable", () => {
  assert.match(source, /\[ADS-AUTH\] clear blocked: not lock owner/);
  assert.match(source, /message: "✅ Import ads success!"/);
  assert.match(source, /logTaskFailed/);
});
