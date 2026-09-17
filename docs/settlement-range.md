# Settlement commands with a date range

`IMPORT_SETTLEMENTS` with `dateFrom` and `dateTo` now discovers closed statements
whose periods overlap the requested inclusive dates (maximum 120 days). Each
Flat File V2 is imported whole, oldest first; this is not a transaction-row filter.
Open `Present` periods are excluded. No-date scheduled discovery is unchanged.
The extension popup's direct manual single-period import is also unchanged.

Discovery uses a dedicated background All Statements tab, follows Next controls,
and closes only that tab. A stuck page, unreadable matching download, or more
than 100 pages fails explicitly. Seller Central DOM/pagination still needs live
verification on the target Chrome profile; fixtures are not Amazon runtime proof.

The existing backend completion check skips completed statements. Resume history
is keyed by a hash of backend URL, token, and statement reference; unscoped legacy
entries are not trusted. A locally tracked processing batch resumes monitoring without uploading again. Each
statement uses the existing content-based idempotency key. On failure the range
stops, retains completed imports, and reports completed row counts. Retry the
same range after resolving the error; completed statements are skipped.

Progress renews the command lease during discovery, download/upload transitions,
and changing import counters/status. Command imports stop monitoring after five
minutes without backend progress. A pending batch remains resumable.

Deploy the backend settlement row-progress changes and lease-renewal endpoint
before reloading this extension. This change does not deploy either component.

Run checks: `node --test tests/*.test.mjs`.
