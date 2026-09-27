import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  shouldCloseAutoCreatedAdsTab,
  shouldReloadDedicatedAdsTab,
} from "../lib/ads-task-tab-policy.js";

test("closes only an auto-created Ads tab after a successful task", () => {
  assert.equal(shouldCloseAutoCreatedAdsTab({ created: true, completed: true }), true);
  assert.equal(shouldCloseAutoCreatedAdsTab({ created: false, completed: true }), false);
  assert.equal(shouldCloseAutoCreatedAdsTab({ created: true, completed: false }), false);
});

test("reloads an owned Ads tab once when fresh headers were not captured", () => {
  assert.equal(shouldReloadDedicatedAdsTab({ captured: false, reloads: 0 }), true);
  assert.equal(shouldReloadDedicatedAdsTab({ captured: false, reloads: 1 }), false);
  assert.equal(shouldReloadDedicatedAdsTab({ captured: true, reloads: 0 }), false);
});

test("Ads imports keep all API work on one dedicated foreground tab", async () => {
  const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

  assert.match(background, /async function openDedicatedAdsTab\(\)[\s\S]*?chrome\.tabs\.create\(\{ url: ADS_CAMPAIGNS_URL, active: true \}\)/);
  assert.match(background, /const tabId = options\.adsTabId \|\| \(await ensureAdsTab\(\)\)\.tabId/);
  assert.match(background, /return withForegroundAdsTab\(run\);/);
});
