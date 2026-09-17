const AMAZON_EVENTS_URL = 'https://sellercentral.amazon.com/payments/api/events-view';
const AMAZON_REQUEST_TIMEOUT_MS = 30_000;
const HEADERS = ['Date', 'Transaction Status', 'Transaction type', 'Order ID', 'Product Details', 'Total product charges', 'Total promotional rebates', 'Amazon fees', 'Other', 'Total (USD)'];

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function cellText(value) {
  if (!value) return '';
  if (value.type === 'LocalizedDate') {
    const date = new Date(Number(value.dateEpochMillis) + 7 * 60 * 60 * 1000);
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
  }
  if (value.type === 'LocalizedCurrency') return Number(value.currency?.amount || 0).toFixed(2);
  if (value.type === 'Link') return cellText(value.linkBody);
  return value.textContent || '';
}

export function buildTransactionCsv(rows = []) {
  return [HEADERS, ...rows.map((row) => {
    const cells = Object.fromEntries((row.tableCells || []).map((cell) => [cell.columnIdentifier, cell.value]));
    return ['POSTED_DATE', 'TRANSACTION_STATUS', 'TRANSACTION_TYPE', 'ORDER_ID', 'DESCRIPTION', 'PRODUCT_CHARGES', 'PROMO_REBATES', 'FEES_TOTAL', 'OTHER_TOTAL', 'TOTAL']
      .map((key) => csvCell(cellText(cells[key]))).join(',');
  })].map((line) => Array.isArray(line) ? line.map(csvCell).join(',') : line).join('\n');
}

export function summarizeTransactionCsv(csv = '') {
  const postedDates = String(csv).split(/\r?\n/).slice(1)
    .map((line) => line.match(/^"((?:""|[^"])*)"/)?.[1]?.replaceAll('""', ''))
    .map((value) => {
      const match = value?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return match ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` : null;
    })
    .filter(Boolean)
    .sort();
  return {
    rowCount: Math.max(String(csv).split(/\r?\n/).filter(Boolean).length - 1, 0),
    postedDateMin: postedDates[0] || null,
    postedDateMax: postedDates.at(-1) || null,
  };
}

function timestamp(date, endOfDay = false) {
  const value = new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+07:00`).getTime();
  if (!Number.isFinite(value)) throw new Error(`Invalid transaction date: ${date}`);
  return value;
}

async function fetchPage({ fetchImpl, startTimestamp, endTimestamp, offset, limit, timeoutMs }) {
  const url = new URL(AMAZON_EVENTS_URL);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('accountType', 'PAYABLE');
  url.searchParams.set('fiqlFiltersString', `(startTimestamp==${startTimestamp});(endTimestamp==${endTimestamp})`);
  url.searchParams.set('sortType', 'DESC');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Amazon transaction request timed out'));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([fetchImpl(url, { credentials: 'include', signal: controller.signal }), timeoutPromise]);
      if (response.ok) return await Promise.race([response.json(), timeoutPromise]);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(`Amazon transaction request failed (${response.status})`);
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Amazon transaction request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    await sleepDefault(500 * (2 ** attempt));
  }
  throw new Error('Amazon transaction request failed');
}

function pageDiagnostic({ page, offset, totalRows, rows }) {
  const postedAts = rows
    .map((row) => Number((row.tableCells || []).find((cell) => cell.columnIdentifier === 'POSTED_DATE')?.value?.dateEpochMillis))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    offset,
    pageNumber: Number(page.tableMetadata?.pageNumber || offset),
    totalRows,
    returnedRows: rows.length,
    postedAtMin: postedAts[0] || null,
    postedAtMax: postedAts.at(-1) || null,
  };
}

function assertRowsWithinRequestedRange(rows, startTimestamp, endTimestamp, dateFrom, dateTo, diagnostic) {
  const outsideRange = rows.find((row) => {
    const postedAt = Number((row.tableCells || []).find((cell) => cell.columnIdentifier === 'POSTED_DATE')?.value?.dateEpochMillis);
    return Number.isFinite(postedAt) && (postedAt < startTimestamp || postedAt > endTimestamp);
  });
  if (outsideRange) {
    const postedAt = Number((outsideRange.tableCells || []).find((cell) => cell.columnIdentifier === 'POSTED_DATE')?.value?.dateEpochMillis);
    throw new Error(`Amazon returned transactions outside requested date range: ${dateFrom} to ${dateTo} (page ${diagnostic.pageNumber}, postedAtEpochMillis ${postedAt})`);
  }
}

export async function fetchTransactionsCsv({ dateFrom, dateTo, fetchImpl = fetch, limit = 10, sleep = sleepDefault, timeoutMs = AMAZON_REQUEST_TIMEOUT_MS, onPage = async () => {} } = {}) {
  const startTimestamp = timestamp(dateFrom);
  const endTimestamp = timestamp(dateTo, true);
  const rows = [];
  const totalLimit = 5000;
  let total = null;
  for (let offset = 1; rows.length < (total ?? 1); offset += 1) {
    if (rows.length >= totalLimit) throw new Error('Amazon transaction result exceeds 5000 rows');
    const page = await fetchPage({ fetchImpl, startTimestamp, endTimestamp, offset, limit, timeoutMs });
    const pageRows = page.tableRows || [];
    total = Number(page.tableMetadata?.numberOfRows ?? rows.length + pageRows.length);
    const diagnostic = pageDiagnostic({ page, offset, totalRows: total, rows: pageRows });
    await onPage(diagnostic);
    assertRowsWithinRequestedRange(pageRows, startTimestamp, endTimestamp, dateFrom, dateTo, diagnostic);
    rows.push(...pageRows);
    if (!pageRows.length || rows.length >= total) break;
    await sleep(500);
  }
  const resultRows = rows.slice(0, total ?? rows.length);
  return buildTransactionCsv(resultRows);
}
