import test from "node:test";
import assert from "node:assert/strict";
import { shouldCloseAutoCreatedAdsTab } from "../lib/ads-task-tab-policy.js";

test("closes only an auto-created Ads tab after a successful task", () => {
  assert.equal(shouldCloseAutoCreatedAdsTab({ created: true, completed: true }), true);
  assert.equal(shouldCloseAutoCreatedAdsTab({ created: false, completed: true }), false);
  assert.equal(shouldCloseAutoCreatedAdsTab({ created: true, completed: false }), false);
});
