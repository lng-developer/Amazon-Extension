export function buildAmazonFeedResult({ watch = {}, event = {}, ack = null, at = Date.now() } = {}) {
  const acknowledged = !!ack?.ok && !!ack?.terminal;
  return {
    batchId: String(watch.batchId || ""),
    amazonBatchId: String(event.amazonBatchId || ""),
    amazonStatus: String(event.status || "needs_review"),
    backendStatus: acknowledged ? String(ack.status || event.status || "needs_review") : "pending_sync",
    expectedRows: Number(watch.expectedRows || 0),
    recordsProcessed: Number(event.recordsProcessed || 0),
    recordsActivated: Number(event.recordsActivated || 0),
    errorCount: Number(event.errorCount || 0),
    warningCount: Number(event.warningCount || 0),
    failureReason: String(event.failureReason || ""),
    at: Number(at),
  };
}

export function upsertAmazonFeedResult(results = [], result, limit = 20) {
  return [result, ...results.filter((item) => item?.batchId !== result.batchId)].slice(0, limit);
}
