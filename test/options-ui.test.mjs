import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const popupHtml = await readFile(new URL("../options.html", import.meta.url), "utf8");
const popupScript = await readFile(new URL("../options.js", import.meta.url), "utf8");
const popupCss = await readFile(new URL("../options.css", import.meta.url), "utf8");

test("popup separates daily operations, ads, upload tracking, and runtime logs into tabs", () => {
  assert.match(popupHtml, /role="tablist"/);
  for (const tab of ["operations", "ads", "upload", "logs"]) {
    assert.match(popupHtml, new RegExp(`data-tab="${tab}"`));
    assert.match(popupHtml, new RegExp(`data-panel="${tab}"`));
  }
});

test("upload diagnostics stay available behind a collapsed advanced section", () => {
  assert.match(popupHtml, /<details class="advanced-tools"/);
  assert.match(popupHtml, /UploadFeed Debug/);
});

test("popup script activates a selected tab without changing action IDs", () => {
  assert.match(popupScript, /function activatePopupTab\(/);
  assert.match(popupScript, /aria-selected/);
});

test("popup uses Chrome's maximum toolbar-popup size", () => {
  assert.match(popupCss, /html, body \{ width:800px; min-height:600px;/);
  assert.match(popupCss, /\.app-shell \{ height:600px;/);
  assert.doesNotMatch(popupCss, /\.log-card \{ min-height:500px; \}/);
});

test("popup can open the same control surface in a full-page tab", () => {
  assert.match(popupHtml, /id="btnOpenDashboard"/);
  assert.match(popupScript, /options\.html\?view=full/);
  assert.match(popupCss, /\.is-full-page/);
});

test("runtime log renders the newest entry at the top", () => {
  assert.match(popupScript, /runtimeEntries\.slice\(\)\.reverse\(\)\.map/);
  assert.match(popupScript, /box\.scrollTop = 0/);
});

test("popup does not expose legacy Auto Config controls", () => {
  assert.doesNotMatch(popupHtml, /btnAutoConfig|autoConfigOverlay/);
  assert.doesNotMatch(popupScript, /loadAutoConfig|_autoConfigTimer/);
});
