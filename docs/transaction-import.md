# Transaction import progress and recovery

Deploy the backend with `POST /api/integration/extension-commands/agent/commands/:commandId/renew` **before** updating/reloading the extension. Old backends reject renewal; the extension stops before uploading rather than running without its command lease.

- Manual date ranges and scheduled date ranges are unchanged.
- Downloaded pages log page number, returned rows and total rows. Upload and backend monitoring are separate log stages.
- Command-backed Transactions renew on progress, at most once per minute within a stage. Changing stage or receiving a batch ID forces renewal. Claimed commands retain their five-minute lease; renewal grants seven minutes, covering the five-minute inactivity window plus throttling and network latency.
- Backend Transactions persist completed-row counters during processing. Monitoring logs status, rows, recalculation count and elapsed time, at least every 30 seconds while requests succeed.
- Five minutes with unchanged batch status/counters stops **monitoring**, not the backend worker. Monitoring also has a two-hour ceiling. These errors retain the batch ID; do not assume the worker was cancelled.
- After receiving a batch ID, the extension stores it under a hash scoped to API URL, token, marketplace and date range. Requesting the same range with the same configuration resumes that batch without downloading/uploading again. A confirmed terminal result removes the pending entry; a failed/partial result still reports an error and retains its batch ID in the command/log. A later manual request may fetch again; server deduplication still applies. Network errors and monitoring timeouts keep the pending entry.
- A second Transactions task in the same extension process is rejected while the first is active.
- Backend status/command requests time out after 30 seconds; file uploads after 120 seconds. Upload acknowledgement can be lost even if the server accepted the file; existing server content-hash/idempotency checks remain the fallback.

This does not remove the Amazon collector's existing 5,000-row guard, change page size, or add automatic retries of failed financial data. It does not retrofit renewal into Orders/Ads/Settlement commands. Settlement monitoring retains its existing 60-poll budget.

Verification: `node --test tests/*.test.mjs`. Test the deployed flow with a small manual range first, then a longer range; confirm the batch and recalculation completed, not only that the command was accepted.

## Popup activity status

Orders and Transactions command activity now carries the backend command ID and explicit lifecycle status. Manual Transactions runs have unique run IDs even when the dates repeat. Matching IDs stay together across long log gaps; time proximity is only a compatibility fallback for old unkeyed logs.

Opening Logs reads the last 100 commands of the authenticated extension agent through `GET /api/integration/extension-commands/agent/commands`. While Logs is open this refreshes every 30 seconds. Exact-ID backend status takes precedence over local logs. Local storage changes also refresh the cards without reopening the popup.

Historical entries without a command ID cannot safely be matched to backend jobs. An unresolved local entry older than seven minutes, or a backend running command with an expired/missing lease, shows **Không xác định** (unknown), not success/failure inferred from elapsed time. Deploy the backend history endpoint before updating the extension. This is a UI correction, not a retry or mutation of old jobs.
