export function extractFeedHistoryIds(rows = []) {
  return [...new Set(rows.map((row) => {
    const text = typeof row === 'object' ? (row?.text || '') : String(row || '');
    return text.match(/\b(?:\d{6,}|[A-Z0-9-]{8,})\b/g) || [];
  }).flat())];
}

export function findNewFeedRow(rows = [], beforeBatchIds = []) {
  const known = new Set(beforeBatchIds.map(String));
  const candidates = rows.filter((row) => extractFeedHistoryIds([row]).some((id) => !known.has(id)));
  return candidates.length === 1 ? candidates[0] : null;
}

export function findFeedRow(rows = [], { amazonBatchId = null, beforeBatchIds = [] } = {}) {
  if (amazonBatchId) {
    const target = String(amazonBatchId).trim();
    const match = rows.find((row) => {
      const text = typeof row === 'object' ? (row?.text || '') : String(row || '');
      return text.includes(target);
    });
    if (match) return match;
  }
  return findNewFeedRow(rows, beforeBatchIds);
}

export function terminalFeedResult(row = '', reportText = null) {
  const text = typeof row === 'object' ? (row?.text || '') : String(row || '');
  const value = text.toUpperCase();
  const report = String(reportText || '');

  // Parse counts from report text or row text
  let importedCount = 1;
  let failedCount = 0;

  const activatedMatch = text.match(/records that were activated:\s*(\d+)/i) || report.match(/records successful\s*(\d+)/i);
  const errorMatch = text.match(/records with errors:\s*(\d+)/i) || report.match(/records with errors\s*(\d+)/i);

  if (activatedMatch) importedCount = parseInt(activatedMatch[1], 10);
  if (errorMatch) failedCount = parseInt(errorMatch[1], 10);

  const diagnostics = [];
  if (report) {
    diagnostics.push(report.slice(0, 2000));
  } else if (failedCount > 0) {
    diagnostics.push(text.slice(0, 500));
  }

  if (/DONE|COMPLETE|SUCCESS/.test(value)) {
    const isSuccess = failedCount === 0;
    return {
      status: isSuccess ? 'SUCCEEDED' : 'FAILED',
      result: {
        importedCount,
        failedCount,
        diagnostics,
        ...(report ? { processingReport: report } : {}),
      },
    };
  }

  if (/ERROR|FAILED|CANCELLED/.test(value)) {
    return {
      status: 'FAILED',
      result: {
        importedCount: 0,
        failedCount: failedCount || 1,
        diagnostics: diagnostics.length ? diagnostics : [text.slice(0, 500)],
        ...(report ? { processingReport: report } : {}),
      },
    };
  }

  return null;
}

export async function snapshotFeedHistory(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => [...document.querySelectorAll('tr')].map((row) => {
      const text = row.innerText || '';
      const links = [...row.querySelectorAll('a')];
      const reportLink = links.find((a) => {
        const t = (a.innerText || '').toLowerCase();
        const h = (a.href || '').toLowerCase();
        return t.includes('processing report') || t.includes('report') || h.includes('report') || h.includes('download');
      });
      const reportHref = reportLink?.href || null;
      return { text, reportHref };
    }),
  });
  return extractFeedHistoryIds(result?.result || []);
}
