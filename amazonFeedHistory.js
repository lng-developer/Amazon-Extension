export function extractFeedHistoryIds(rows = []) {
  return [...new Set(rows.map((row) => String(row || '').match(/\b(?:\d{6,}|[A-Z0-9-]{8,})\b/g) || []).flat())];
}

export function findNewFeedRow(rows = [], beforeBatchIds = []) {
  const known = new Set(beforeBatchIds.map(String));
  const candidates = rows.filter((row) => extractFeedHistoryIds([row]).some((id) => !known.has(id)));
  return candidates.length === 1 ? candidates[0] : null;
}

export function terminalFeedResult(row = '') {
  const value = String(row).toUpperCase();
  if (/DONE|COMPLETE|SUCCESS/.test(value)) return { status: 'SUCCEEDED', result: { importedCount: 1, failedCount: 0, diagnostics: [] } };
  if (/ERROR|FAILED|CANCELLED/.test(value)) return { status: 'FAILED', result: { importedCount: 0, failedCount: 1, diagnostics: [String(row).slice(0, 500)] } };
  return null;
}

export async function snapshotFeedHistory(tabId) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => [...document.querySelectorAll('tr')].map((row) => row.innerText || '') });
  return extractFeedHistoryIds(result?.result || []);
}
