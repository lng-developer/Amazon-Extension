function normalizeStatus(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source.includes("in progress")) return "processing";
  if (source.includes("done")) return "done";
  if (source.includes("error") || source.includes("failed")) return "failed";
  return "submitted";
}

function numberAfterLabel(text, label) {
  const match = String(text || "").match(new RegExp(`${label}\\s*(?::|\\t+)\\s*(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

export function findNewAmazonFeedRow({ beforeBatchIds = [], rows = [] } = {}) {
  const known = new Set(beforeBatchIds.map((id) => String(id || "").trim()));
  const row = rows.find((item) => item?.amazonBatchId && !known.has(String(item.amazonBatchId).trim()));
  if (!row) return null;
  return {
    amazonBatchId: String(row.amazonBatchId).trim(),
    status: normalizeStatus(row.status),
    reportHref: String(row.reportHref || ""),
  };
}

export function parseAmazonProcessingReport(reportText) {
  const text = String(reportText || "");
  const recordsProcessed = numberAfterLabel(text, "Number of records processed from this upload")
    || numberAfterLabel(text, "Number of records processed");
  const recordsSuccessful = numberAfterLabel(text, "Number of records successful");
  return {
    status: normalizeStatus((text.match(/Status\s*:\s*([^\r\n]+)/i) || [])[1]),
    recordsProcessed,
    recordsActivated: numberAfterLabel(text, "Number of records that were activated") || recordsSuccessful,
    errorCount: numberAfterLabel(text, "Number of records with errors"),
    warningCount: numberAfterLabel(text, "Number of records with warnings"),
  };
}

export function buildAmazonFeedDoneEvent({ batchId, amazonBatchId, reportText }) {
  return {
    batchId,
    amazonBatchId,
    ...parseAmazonProcessingReport(reportText),
    status: "done",
    reportText,
  };
}

export function nextAmazonFeedWatchState(watch = {}, row = {}) {
  const status = normalizeStatus(row.status || watch.status);
  const amazonBatchId = String(row.amazonBatchId || watch.amazonBatchId || "").trim();
  if (status === "done") return { ...watch, amazonBatchId, status, action: "fetch_report", terminal: false };
  if (status === "failed") return { ...watch, amazonBatchId, status, action: "report_failure", terminal: true };
  return { ...watch, amazonBatchId, status, action: "poll", terminal: false };
}

export function shouldRefreshAmazonFeedHistory(watch = {}, source = "alarm") {
  return watch.createdDedicatedTab === true && source === "alarm";
}
