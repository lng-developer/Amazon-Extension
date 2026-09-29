# V2 Ads and Upload Tracking Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate v1's stable Ads safeguards and Seller Central tracking submission into v2's leased extension-command architecture.

**Architecture:** Ads remains a v2 Finance import command; the extension adds range/preview controls while retaining the existing report-to-Finance pipeline. Tracking becomes a new V2 command and backend-owned batch lifecycle; only the extension interacts with Seller Central and the backend records the Amazon terminal result.

**Tech Stack:** Chrome Extension Manifest V3, browser-native JavaScript, Node.js, Express, Mongoose, Joi, node:test, Jest.

**Spec:** `docs/superpowers/specs/2026-09-29-v2-ads-upload-tracking-migration-design.md`

## Global Constraints

- Do not copy v1 Socket.IO, `/APO/*`, or `/api/shipping-batch*` contracts.
- Use the existing V2 extension Bearer token and shop-scoped authorization.
- Do not persist Amazon cookies, CSRF values, or TSV content in backend logs.
- A Seller Central acknowledgement is `SUBMITTED`; only a terminal Processing Report is `SUCCEEDED` or `FAILED`.
- Keep one upload lock per extension agent; add per-marketplace concurrency only when throughput requires it.
- No production Seller Central submission or deployment without separate explicit approval.

## Review Focus

- A date range with `dateFrom > dateTo` must be rejected before any Ads API request; covered in Task 1.
- An expired Ads session must stop before reporting/import; covered in Task 2.
- A lost command lease must prevent an upload submission; covered in Task 4.
- A browser timeout after an upload acknowledgement must reconcile by feed id, not resubmit; covered in Task 5.
- A terminal Amazon row error must complete the V2 command as failed with bounded diagnostics; covered in Task 5.

---

### Task 1: Ads range command and popup controls

**Files:**
- Modify: `options.html`, `options.js`, `background.js`, `extensionCommandClient.js`
- Modify: `tests/extension-command-client.test.mjs`, `tests/ads-reporting.test.mjs`

**Interfaces:**
- Produces: `queueAdsSpendCommand({ base, token, client, dateFrom, dateTo, fetchImpl })` and `runExportAdsSpend({ dateFrom, dateTo, dryRun, preview })`.
- Consumes: existing `createAndRunAdsReport`, `waitForAdsReport`, `downloadAdsReportCsv`, and Finance `postFileTo`.

- [ ] **Step 1: Write failing extension tests**

Add node tests that assert a range command posts both ISO dates to `/agent/import-ads-spend`, and `buildOneOffReportConfig(template, dateFrom, dateTo)` rejects an inverted range while retaining the two supplied boundaries.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test tests/extension-command-client.test.mjs tests/ads-reporting.test.mjs`

Expected: FAIL because the command accepts only `date` and the report builder accepts one date.

- [ ] **Step 3: Implement the minimal range contract and UI**

Change `queueAdsSpendCommand` and `queueManualAdsSpend` to carry `dateFrom` and `dateTo`. Replace the single popup date input with labeled From/To date inputs plus Preview, Dry-run and Import buttons. Preview reads/report-validates only; Dry-run must not call `postFileTo`; Import retains the current Finance ingest call and returns its row count.

- [ ] **Step 4: Run focused extension tests**

Run: `node --test tests/extension-command-client.test.mjs tests/ads-reporting.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add options.html options.js background.js extensionCommandClient.js tests/extension-command-client.test.mjs tests/ads-reporting.test.mjs
git commit -m "feat(extension): support v2 Ads date ranges"
```

### Task 2: Ads session and concurrent-run safeguards

**Files:**
- Modify: `background.js`, `ads_bridge.js`
- Modify: `tests/ads-reporting.test.mjs`

**Interfaces:**
- Produces: `runExportAdsSpend({ dateFrom, dateTo, dryRun, preview })` guarded by the existing `withAdsApiLock` and `ensureFreshAdsReportingHeaders()`.
- Consumes: the shared `adsApiLock` and header-capture storage keys.

- [ ] **Step 1: Write failing policy tests**

Add tests proving a second Ads run receives `ADS_TASK_ALREADY_RUNNING`, and an invalid/missing header state rejects before report creation or Finance upload.

- [ ] **Step 2: Run the policy tests to verify they fail**

Run: `node --test tests/ads-reporting.test.mjs`

Expected: FAIL because no policy helper exposes the requested preflight outcomes.

- [ ] **Step 3: Extract only the testable policy helper required by the tests**

Keep browser tab/capture code in `background.js`; add a small pure helper in the existing Ads module only if needed to determine lock/header preflight. Use it from both manual and leased `IMPORT_ADS_SPEND` paths. Do not add a new dependency or a second Ads pipeline.

- [ ] **Step 4: Run focused extension tests**

Run: `node --test tests/ads-reporting.test.mjs tests/extension-command-client.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js ads_bridge.js adsReporting.js tests/ads-reporting.test.mjs
git commit -m "fix(extension): guard v2 Ads report imports"
```

### Task 3: V2 backend tracking command and batch record

**Files:**
- Create: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/amazonTrackingSubmission/models/amazonTrackingSubmission.model.js`
- Create: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/amazonTrackingSubmission/services/amazonTrackingSubmission.service.js`
- Create: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/amazonTrackingSubmission/repositories/amazonTrackingSubmission.repository.js`
- Create: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/amazonTrackingSubmission/validators/amazonTrackingSubmission.validator.js`
- Modify: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/extensionCommand/constants/extensionCommand.constants.js`, `models/extensionCommand.model.js`, `validators/extensionCommand.validator.js`, `services/extensionCommand.service.js`, `controllers/extensionCommand.controller.js`, `routes/extensionCommand.routes.js`
- Test: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/extensionCommand/__tests__/extensionCommand.validator.test.js`, new `amazonTrackingSubmission/__tests__/amazonTrackingSubmission.service.test.js`

**Interfaces:**
- Produces: `createSubmission({ shopId, agentId, rows, auth }) -> { command, submissionId }`, `getLeasedPayload({ commandId, leaseToken, auth }) -> { submissionId, filename, tsv, rowCount, checksum }`, `markSubmitted({ submissionId, feedId, auth })`, and `markTerminal({ submissionId, status, result, auth })`.
- Consumes: shop-scoped extension authentication and the existing command lease identity.

- [ ] **Step 1: Write failing backend tests**

Add tests that reject a non-extension/shop-mismatched payload request, accept `UPLOAD_TRACKING` as one active command per agent, and create an immutable checksum-bound TSV batch without storing its content in logs.

- [ ] **Step 2: Run the focused backend tests to verify they fail**

Run: `npm test -- --runInBand src/modules/integration/extensionCommand/__tests__/extensionCommand.validator.test.js src/modules/integration/amazonTrackingSubmission/__tests__/amazonTrackingSubmission.service.test.js`

Expected: FAIL because the command type, submission model and service do not exist.

- [ ] **Step 3: Implement the backend-owned submission lifecycle**

Add `UPLOAD_TRACKING` to command constants/model/validator and include it in the existing per-agent active-command lock. The new module owns candidate-row snapshot, TSV generation, SHA-256 checksum, submission state (`QUEUED`, `SUBMITTED`, `SUCCEEDED`, `FAILED`) and bounded diagnostics. Wire thin command routes/controllers to create, lease-read, mark submitted and mark terminal; enforce the extension token's shop and the claimed command's lease at every state change.

- [ ] **Step 4: Run focused backend tests**

Run: `npm test -- --runInBand src/modules/integration/extensionCommand/__tests__/extensionCommand.validator.test.js src/modules/integration/amazonTrackingSubmission/__tests__/amazonTrackingSubmission.service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit in the backend repository**

```bash
git -C C:/lng_system/lng-web/lng-web-be add src/modules/integration
git -C C:/lng_system/lng-web/lng-web-be commit -m "feat(integration): add tracking submission commands"
```

### Task 4: Extension tracking command dispatcher and native feed submit

**Files:**
- Create: `amazonTrackingUpload.js`, `amazonFeedHistory.js`
- Modify: `background.js`, `extensionCommandClient.js`, `manifest.json`
- Test: `tests/extension-command-client.test.mjs`, new `tests/amazon-tracking-upload.test.mjs`

**Interfaces:**
- Consumes: `UPLOAD_TRACKING` command payload and `getLeasedPayload`, `markSubmitted`, `markTerminal` backend endpoints from Task 3.
- Produces: `runTrackingUpload({ command, leaseToken, onProgress }) -> { submissionId, feedId, importedCount, failedCount }`.

- [ ] **Step 1: Write failing extension tests**

Add tests that `pollExtensionCommand` dispatches `UPLOAD_TRACKING`, renews before native submission, serializes concurrent uploads with `UPLOAD_TRACKING_ALREADY_RUNNING`, and sends the backend `markSubmitted` call exactly once with the feed id.

- [ ] **Step 2: Run focused extension tests to verify they fail**

Run: `node --test tests/extension-command-client.test.mjs tests/amazon-tracking-upload.test.mjs`

Expected: FAIL because `UPLOAD_TRACKING` is unsupported and no upload module exists.

- [ ] **Step 3: Implement the smallest native-feed adapter**

Move only v1's proven TSV validation, Seller Central page-context form submit and CSRF preflight into `amazonTrackingUpload.js`; expose pure TSV/status parsing in `amazonFeedHistory.js`. The dispatcher fetches the leased snapshot, validates checksum/row count, renews the lease before submission, persists the returned Amazon feed id through Task 3's endpoint, and never logs TSV/cookies/CSRF. Update Manifest permissions only after the adapter's API calls demonstrate a missing permission.

- [ ] **Step 4: Run focused extension tests**

Run: `node --test tests/extension-command-client.test.mjs tests/amazon-tracking-upload.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add background.js extensionCommandClient.js manifest.json amazonTrackingUpload.js amazonFeedHistory.js tests/extension-command-client.test.mjs tests/amazon-tracking-upload.test.mjs
git commit -m "feat(extension): submit v2 Amazon tracking feeds"
```

### Task 5: Processing Report reconciliation and terminal command result

**Files:**
- Modify: `amazonFeedHistory.js`, `amazonTrackingUpload.js`, `background.js`
- Modify: `C:/lng_system/lng-web/lng-web-be/src/modules/integration/amazonTrackingSubmission/services/amazonTrackingSubmission.service.js`
- Test: `tests/amazon-tracking-upload.test.mjs`, `C:/lng_system/lng-web/lng-web-be/src/modules/integration/amazonTrackingSubmission/__tests__/amazonTrackingSubmission.service.test.js`

**Interfaces:**
- Consumes: persisted `{ submissionId, feedId, checksum }` and Amazon Processing Report status.
- Produces: terminal `markTerminal({ submissionId, status: 'SUCCEEDED' | 'FAILED', result, auth })` before the command `complete` call.

- [ ] **Step 1: Write failing reconciliation tests**

Add tests for: submitted-but-unknown state continues polling; a timeout after feed id persistence resumes history lookup without calling submit; `DONE` completes successfully; and an Amazon row error completes failed with the first bounded diagnostics.

- [ ] **Step 2: Run focused reconciliation tests to verify they fail**

Run: `node --test tests/amazon-tracking-upload.test.mjs`

Expected: FAIL because the module has no terminal-state reconciliation.

- [ ] **Step 3: Implement feed-history reconciliation**

Poll only the persisted feed id from the dedicated Seller Central history page. Renew the command lease on progress, call `markTerminal` exactly once for a terminal status, then let `pollExtensionCommand` complete the leased command. On a non-terminal timeout, leave the submission `SUBMITTED` and surface a retryable reconciliation error; do not call native submission again.

- [ ] **Step 4: Run focused extension and backend tests**

Run: `node --test tests/amazon-tracking-upload.test.mjs`

Run: `npm test -- --runInBand src/modules/integration/amazonTrackingSubmission/__tests__/amazonTrackingSubmission.service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit each repository**

```bash
git add amazonFeedHistory.js amazonTrackingUpload.js background.js tests/amazon-tracking-upload.test.mjs
git commit -m "feat(extension): reconcile Amazon tracking feeds"
git -C C:/lng_system/lng-web/lng-web-be add src/modules/integration/amazonTrackingSubmission
git -C C:/lng_system/lng-web/lng-web-be commit -m "feat(integration): persist tracking feed results"
```

### Task 6: Regression verification and staging readback

**Files:**
- Modify if needed: test files from Tasks 1-5 only

**Interfaces:**
- Consumes: completed migration tasks.
- Produces: recorded development-environment evidence; no production submission.

- [ ] **Step 1: Run complete extension suite**

Run: `node --test tests/*.test.mjs`

Expected: PASS with no skipped new migration tests.

- [ ] **Step 2: Run complete backend suite**

Run: `npm test -- --runInBand`

Expected: PASS; report every pre-existing failure separately if present.

- [ ] **Step 3: Perform staging-only readback**

Using a non-production shop and explicitly approved safe batch, verify the created command, persisted submission id/checksum, Amazon feed id, terminal Processing Report, and final backend command status. Do not invoke this step against production without a new explicit approval.

- [ ] **Step 4: Commit only any test fixes caused by the verification**

```bash
git add tests
git commit -m "test(extension): cover v2 tracking migration"
```

## Self-review

- Spec coverage: Tasks 1-2 cover Ads; Tasks 3-5 cover the V2 tracking command, native upload, persisted feed id and terminal reconciliation; Task 6 supplies the required staging proof.
- Type consistency: `UPLOAD_TRACKING`, `submissionId`, `feedId`, and `markTerminal` use the same names across backend and extension tasks.
- Review focus: each listed failure mode has an explicit failing test in its owning task.
- Scope: the plan excludes legacy route/socket migration, Gmail/OAuth work, broad historic resubmission, and production release.
