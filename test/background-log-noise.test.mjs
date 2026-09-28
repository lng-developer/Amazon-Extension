import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");

test("Feed CSRF sniffer is installed by an upload task, not by every Feed-tab refresh", () => {
  assert.match(source, /await installUploadFeedCsrfSniffer\(tab\.id\);/);
  assert.doesNotMatch(source, /if \(!url\.startsWith\(SC_FEEDS_URL\)\) return;/);
});

test("tracking upload keeps no duplicate server log for file preparation", () => {
  assert.doesNotMatch(source, /^\s*await postLogSingle\(\{[\s\S]{0,500}message:\s*`📄 Prepared file:/m);
  assert.doesNotMatch(source, /^\s*await postLogSingle\(\{[\s\S]{0,500}message:\s*`Starting upload to Amazon:/m);
  assert.doesNotMatch(source, /^\s*await postLogSingle\(\{[\s\S]{0,500}message:\s*`Amazon upload completed:/m);
});

test("successful socket connection is not posted as a background operational log", () => {
  assert.doesNotMatch(source, /^\s*safePostLogSingle\(\{[\s\S]{0,500}message:\s*"✅ Extension connected to Socket\.IO"/m);
});

test("task diagnostics do not print TSV or tracking samples", () => {
  assert.doesNotMatch(source, /Content preview:/);
  assert.doesNotMatch(source, /Sample orders:/);
});

test("upload diagnostics only enter the runtime log when they are errors", () => {
  const diagnostic = source.match(/function logUploadTrackingDiagnostic[\s\S]*?\r?\n}\r?\n\r?\nfunction isValidUploadFeedCsrfToken/);
  assert.ok(diagnostic);
  assert.doesNotMatch(diagnostic[0], /extensionLogger\?\.logInfo/);
  assert.match(diagnostic[0], /if \(level === "error"\) debugLog\(fullMessage, level\);/);
});
