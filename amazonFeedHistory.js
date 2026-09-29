export function extractFeedHistoryIds(rows = []) {
  return [...new Set(rows.map((row) => String(row || '').match(/\b(?:\d{6,}|[A-Z0-9-]{8,})\b/g) || []).flat())];
}

export async function snapshotFeedHistory(tabId) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => [...document.querySelectorAll('tr')].map((row) => row.innerText || '') });
  return extractFeedHistoryIds(result?.result || []);
}
