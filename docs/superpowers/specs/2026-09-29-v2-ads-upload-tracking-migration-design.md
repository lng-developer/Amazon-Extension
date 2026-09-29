# V2 Ads and Upload Tracking Migration

## Goal

Bring the stable Amazon Ads and Seller Central upload-tracking capabilities from `EC/amazon-extension-v1` into `EC/amazon-extension-v2` without reintroducing v1's Socket.IO or `/api/shipping-batch*` contracts. V2 remains the development extension and uses the leased `/api/integration/extension-commands` contract.

## Current state

- The branches diverged; this is a selective behaviour migration, not a cherry-pick.
- V2 already imports one-day Ads Reporting CSV files through its command client and Finance ingest API.
- V1 adds range selection, CSRF/header refresh and locking for Ads; these must be adapted to V2's existing Ads reporting flow.
- V1 tracking obtains candidate orders from legacy shipping-batch routes, uploads a TSV with Seller Central's native feed form, then polls Processing Report history.
- V2 has no tracking command or UI. Its extension command client and backend whitelist deliberately reject `UPLOAD_TRACKING`.

## Chosen design

### Ads

Keep V2's `IMPORT_ADS_SPEND` command, Reporting CSV creation and Finance upload contract. Port only the mature client-side safeguards:

- date-range input and Preview/Dry-run/Import actions;
- one Ads lock shared by manual and leased runs;
- refresh Ads CSRF/session headers in the dedicated Ads tab before reporting calls;
- preserve the original CSV and existing V2 completion semantics.

No Gmail redirect path or legacy Ads endpoints are migrated. The extension must report success only after V2 Finance ingest responds successfully.

### Upload tracking

Add a V2 leased command type, `UPLOAD_TRACKING`, with this lifecycle:

1. A V2 backend route creates a command for one scoped extension agent and provides a backend-created tracking batch reference plus immutable TSV payload metadata.
2. The extension validates the payload locally, acquires its upload lock, opens Seller Central's dedicated feeds page, and submits the TSV using the native form in page context.
3. Submission stores the Amazon feed/batch identifier in V2 and renews the command lease while the Processing Report is polled.
4. Only a terminal Amazon Processing Report completes the command. A submission acknowledgement is `SUBMITTED`, not `SUCCEEDED`.
5. The backend records terminal success or failure, affected row counts, Amazon feed id and bounded diagnostic text. Lease expiry makes the command retryable only when no terminal Amazon result was recorded.

The backend owns candidate selection, batch creation, deduplication and submission state. The extension owns Amazon browser/session interaction only. A single extension-agent lock serializes uploads; that is sufficient until measured throughput needs per-marketplace concurrency.

## Contracts and permissions

- Add `UPLOAD_TRACKING` to V2 extension-command constants, validator, claim whitelist and extension dispatcher.
- Add explicit V2 backend endpoints for requesting a tracking command, obtaining/acknowledging the batch payload and recording submitted/terminal feed state. Do not call `/api/shipping-batch*`, `/APO/*` or Socket.IO routes.
- Require the existing extension Bearer token and shop-scoped authorization. The command's agent and shop must match the authenticated extension agent.
- Keep Amazon feed submission in the authenticated browser session. Do not store Amazon cookies, CSRF values or feed file contents in backend logs.
- The manifest needs only permissions proven necessary by the native feed submission and diagnostic download; do not copy V1 permissions blindly.

## Failure handling

- Missing or stale Amazon session/CSRF: fail the command with an actionable re-login message; do not retry in a loop.
- Invalid TSV or mismatched batch metadata: fail before Amazon submission and preserve the backend batch for correction/retry.
- Network interruption after submission: reconcile by feed id and Processing Report history before any retry; never submit a second feed solely because the UI acknowledgement was lost.
- A feed-level terminal failure records row-level diagnostics where Amazon supplies them. Unknown/timeout remains non-terminal and continues polling within the command lease policy.

## Verification

- Unit tests first for Ads range/lock/header policy, command type validation/dispatch, TSV validation, and feed-terminal state handling.
- Focused extension and backend test suites must pass after each migration slice.
- Manual staging proof uses a non-production shop and a deliberately safe tracking batch: inspect submitted feed id, read its Processing Report, and read back the V2 command and batch status.
- Production release requires a separate explicit approval and post-release command/feed readback; this migration does not authorize a live Seller Central submission.

## Out of scope

- Copying V1's legacy backend contracts, Socket.IO control flow, or production configuration.
- Gmail-based Ads report downloading, Ads OAuth work, or broad historical tracking resubmission.
- Claiming that carrier evidence or a submitted TSV proves Amazon accepted the tracking update.
