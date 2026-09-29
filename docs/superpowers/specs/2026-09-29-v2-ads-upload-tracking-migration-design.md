# V2 Ads and Upload Tracking Migration

## Goal

Bring the stable Amazon Ads and Seller Central upload-tracking capabilities from `EC/amazon-extension-v1` into `EC/amazon-extension-v2` without reintroducing v1's Socket.IO or `/api/shipping-batch*` contracts. V2 remains the development extension and uses the leased `/api/integration/extension-commands` contract.

## Current state

- The branches diverged; this is a selective behaviour migration, not a cherry-pick.
- V2 already imports one-day Ads Reporting CSV files through its command client and Finance ingest API.
- V1 Ads has three range actions: Preview reads Amazon only; Dry-run sends one legacy backend import per day with `dryRun: true`; Import sends one non-dry-run import per day. All three share an Ads lock, dedicated foreground Ads tab and header refresh.
- V1 tracking has two paths. The legacy auto path obtains candidates from `/api/shipping-batch*` and is not portable. The stable task path receives a backend-created TSV/batch, validates it, submits it through Seller Central's native form, snapshots Feed History before submission, then polls the newly appearing Amazon feed row and its Processing Report.
- V2 has no tracking command or UI. Its extension command client and backend whitelist deliberately reject `UPLOAD_TRACKING`.

## Chosen design

### Ads

Keep V2's `IMPORT_ADS_SPEND` command, Reporting CSV creation and Finance upload contract. Port only the mature client-side safeguards:

- date-range input and Preview/Dry-run/Import actions;
- one Ads lock shared by manual and leased runs;
- refresh Ads CSRF/session headers in the dedicated Ads tab before reporting calls;
- execute a range as one report/import per calendar day, preserving the original V2 CSV and Finance ingest semantics;
- make only the extension's explicit Dry-run/Test action call the V2 Finance ingest endpoint with `dryRun: true`, while Preview never calls Finance ingest and every backend-issued `IMPORT_ADS_SPEND` uses `dryRun: false`.

No Gmail redirect path or legacy Ads endpoints are migrated. The extension must report success only after V2 Finance ingest responds successfully.

The V2 Finance contract accepts multipart `dryRun` as a boolean and defaults it to `true`; every import action must send an explicit value. `PREVIEW_ADS_SPEND` and `DRY_RUN_ADS_SPEND` are local popup actions, not backend commands. `DRY_RUN_ADS_SPEND` sends `true`; the leased `IMPORT_ADS_SPEND` dispatcher always sends `false`, including backend/scheduler-issued commands. The manual extension-command endpoint currently enforces one day, so it must accept an inclusive range of at most 120 calendar days. The extension executes the days sequentially under one Ads lock and one leased command, uploading one original CSV per day with a deterministic `sourceRef` and idempotency key.

### Upload tracking

Add a V2 leased command type, `UPLOAD_TRACKING`, with this lifecycle:

1. A V2 backend route creates a command for one scoped extension agent and a backend-created immutable TSV snapshot, identified by `submissionId`, checksum and expected row count.
2. The extension acquires its upload lock, lease-reads that payload, validates exact TSV/checksum/row count, then snapshots current Seller Central Feed History before native-form submission in page context.
3. On a successful browser acknowledgement, the extension records `SUBMITTED` against `submissionId` but does not invent an Amazon feed id. It opens a persisted one-minute watcher that identifies the new Feed History row by excluding the pre-submission ids.
4. The watcher persists the discovered `amazonBatchId`, polls its Processing Report, and renews the command lease while work continues.
5. After the native acknowledgement, the command becomes `WAITING_AMAZON`: it keeps the per-agent active key but has no expiring browser lease. A restarted extension claims that waiting command and resumes the watcher only; it must not submit again.
6. Only a terminal Processing Report marks the submission and command `SUCCEEDED` or `FAILED`, with row counts and bounded diagnostics. A lost acknowledgement or timeout remains `SUBMITTED` and reconciles by `submissionId` plus Feed History before any retry.

The backend owns candidate selection, batch creation, deduplication and submission state. The extension owns Amazon browser/session interaction only. A single extension-agent lock serializes uploads; that is sufficient until measured throughput needs per-marketplace concurrency.

### Shipment Workbench UI

Extend the existing `lng-web-fe` Shipment Workbench; do not add a separate tracking application or automatic candidate discovery. A user with shipment write permission selects explicit eligible Amazon shipments already shown in the table and invokes “Submit Amazon tracking”. The UI creates one submission for the selected extension agent, then renders its submission status, row count and bounded diagnostic. It may refresh the command/submission state, but never exposes TSV content, Amazon cookies or CSRF values. The submit action is disabled unless one eligible row and one online extension agent are selected.

## Contracts and permissions

- Add `UPLOAD_TRACKING` and `WAITING_AMAZON` to V2 extension-command constants, model, validator, claim/reclaim logic and extension dispatcher.
- A submission starts only from an explicit list of `shipmentIds` supplied by an authorized management user. Each shipment must belong to the command shop, have a nonempty carrier/tracking number, have `SHIPPED` or `DELIVERED` status, and resolve through an Amazon order/item. Snapshot the resolved rows and reject any shipment already attached to a non-terminal submission. Automatic candidate discovery is out of scope until it has an approved independent policy.
- Add explicit V2 backend endpoints for creating that submission, lease-reading the batch payload, recording `SUBMITTED`, transitioning the command to `WAITING_AMAZON`, persisting discovered `amazonBatchId`, and recording terminal feed state. A `WAITING_AMAZON` command may be reclaimed only by the same agent and resumes polling only. Do not call `/api/shipping-batch*`, `/APO/*` or Socket.IO routes.
- The Shipment Workbench uses management-only create/list submission endpoints; the extension-only payload and state-transition endpoints remain unavailable to browser users.
- Require the existing extension Bearer token and shop-scoped authorization. The command's agent and shop must match the authenticated extension agent.
- Keep Amazon feed submission in the authenticated browser session. Do not store Amazon cookies, CSRF values or feed file contents in backend logs.
- The manifest needs only permissions proven necessary by the native feed submission and diagnostic download; do not copy V1 permissions blindly.

## Failure handling

- Missing or stale Amazon session/CSRF: fail the command with an actionable re-login message; do not retry in a loop.
- Invalid TSV or mismatched batch metadata: fail before Amazon submission and preserve the backend batch for correction/retry.
- Network interruption after submission: reconcile from the persisted submission and the Feed History snapshot before any retry; never submit a second feed solely because the UI acknowledgement was lost.
- A feed-level terminal failure records row-level diagnostics where Amazon supplies them. Unknown/timeout remains non-terminal as `WAITING_AMAZON`; a recovered agent reclaims and polls it without re-uploading.

## Verification

- Unit tests first for Ads range/lock/header policy, command type validation/dispatch, TSV validation, and feed-terminal state handling.
- Frontend tests cover explicit selection, disabled unsafe submit state, create payload, and the distinction between `WAITING_AMAZON` and terminal Amazon status.
- Focused extension and backend test suites must pass after each migration slice.
- Manual staging proof uses a non-production shop and a deliberately safe tracking batch: inspect the submission snapshot, observed Feed History id, Processing Report, and final V2 command/batch status.
- Production release requires a separate explicit approval and post-release command/feed readback; this migration does not authorize a live Seller Central submission.

## Out of scope

- Copying V1's legacy backend contracts, Socket.IO control flow, or production configuration.
- Gmail-based Ads report downloading, Ads OAuth work, or broad historical tracking resubmission.
- Claiming that carrier evidence or a submitted TSV proves Amazon accepted the tracking update.
