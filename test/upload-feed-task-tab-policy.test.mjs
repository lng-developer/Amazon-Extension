import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSafeUploadFeedCsrfDiagnostic,
  canSubmitAmazonRow,
  getReadOnlyUploadFeedWarmupSelectors,
  summarizeNativeUploadForm,
  shouldNavigateSellerCentralFeedsTab,
  selectReadOnlyUploadFeedCsrfCapture,
  shouldCloseDedicatedUploadFeedTab,
} from "../lib/upload-feed-task-tab-policy.js";

test("requires server-derived ship date before Amazon submission", () => {
  assert.equal(canSubmitAmazonRow({ tracking: "921", carrier: "USPS", shipDate: "" }), false);
  assert.equal(canSubmitAmazonRow({ tracking: "921", carrier: "USPS", shipDate: "2026-09-18" }), true);
});

test("keeps a dedicated feeds tab open when upload fails", () => {
  assert.equal(shouldCloseDedicatedUploadFeedTab({ created: true, uploaded: false }), false);
});

test("closes only a dedicated feeds tab after Amazon accepts the upload", () => {
  assert.equal(shouldCloseDedicatedUploadFeedTab({ created: true, uploaded: true }), true);
  assert.equal(shouldCloseDedicatedUploadFeedTab({ created: false, uploaded: true }), false);
});

test("prefers the passive Seller Central cookie over storage and page data", () => {
  assert.deepEqual(
    selectReadOnlyUploadFeedCsrfCapture({ cookieToken: "cookie", storageToken: "storage", pageToken: "page" }),
    { token: "cookie", source: "readOnlyCookie" },
  );
});

test("uses the Seller Central storage token when no cookie exists", () => {
  assert.deepEqual(
    selectReadOnlyUploadFeedCsrfCapture({ storageToken: "storage", pageToken: "page" }),
    { token: "storage", source: "readOnlyStorage" },
  );
});

test("uses upload-form controls only for read-only CSRF warm-up", () => {
  assert.deepEqual(getReadOnlyUploadFeedWarmupSelectors(), [
    '[data-testid*="upload" i]',
    'button[aria-label*="upload" i]',
    'button',
  ]);
});

test("keeps the active feeds page intact during a readiness check", () => {
  assert.equal(
    shouldNavigateSellerCentralFeedsTab({
      currentUrl: "https://sellercentral.amazon.com/order-reports-and-feeds/feeds",
      targetUrl: "https://sellercentral.amazon.com/order-reports-and-feeds/feeds",
    }),
    false,
  );
});

test("keeps native upload diagnostics to structural metadata", () => {
  assert.deepEqual(
    summarizeNativeUploadForm({
      action: "https://sellercentral.amazon.com/order-reports-and-feeds/api/uploadFeed",
      method: "post",
      fileInputCount: 1,
      submitControls: ["Upload now"],
    }),
    {
      actionPath: "/order-reports-and-feeds/api/uploadFeed",
      method: "POST",
      fileInputCount: 1,
      submitControls: ["Upload now"],
    },
  );
});

test("keeps CSRF diagnostics metadata-only", () => {
  assert.deepEqual(
    buildSafeUploadFeedCsrfDiagnostic({
      cookieNames: ["session-id", "anti-csrftoken-a2z", "x-amz-token"],
      page: { formFields: ["file", "csrfToken"], localStorageKeys: ["csrfToken"], windowKeys: ["csrfToken"], scriptMentionsCsrf: true },
    }),
    {
      csrfCookieNames: ["anti-csrftoken-a2z", "x-amz-token"],
      csrfFormFields: ["csrfToken"],
      localStorageKeys: ["csrfToken"],
      sessionStorageKeys: [],
      windowKeys: ["csrfToken"],
      scriptMentionsCsrf: true,
    },
  );
});
