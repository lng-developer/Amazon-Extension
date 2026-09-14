const AMAZON_EVENTS_URL = 'https://sellercentral.amazon.com/payments/api/events-view';
const HEADERS = ['Date', 'Transaction Status', 'Transaction type', 'Order ID', 'Product Details', 'Total product charges', 'Total promotional rebates', 'Amazon fees', 'Other', 'Total (USD)'];

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function cellText(value) {
  if (!value) return '';
  if (value.type === 'LocalizedDate') {
    const date = new Date(value.dateEpochMillis);
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
  const value = new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).getTime();
  if (!Number.isFinite(value)) throw new Error(`Invalid transaction date: ${date}`);
  return value;
}

async function fetchPage({ fetchImpl, startTimestamp, endTimestamp, offset, limit }) {
  const url = new URL(AMAZON_EVENTS_URL);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('accountType', 'PAYABLE');
  url.searchParams.set('fiqFiltersString', `(startTimestamp==${startTimestamp});(endTimestamp==${endTimestamp})`);
  url.searchParams.set('sortType', 'DESC');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(url, { credentials: 'include' });
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(`Amazon transaction request failed (${response.status})`);
    await sleepDefault(500 * (2 ** attempt));
  }
  throw new Error('Amazon transaction request failed');
}

function assertRowsWithinRequestedRange(rows, startTimestamp, endTimestamp, dateFrom, dateTo) {
  const outsideRange = rows.some((row) => {
    const postedAt = Number((row.tableCells || []).find((cell) => cell.columnIdentifier === 'POSTED_DATE')?.value?.dateEpochMillis);
    return Number.isFinite(postedAt) && (postedAt < startTimestamp || postedAt > endTimestamp);
  });
  if (outsideRange) throw new Error(`Amazon returned transactions outside requested date range: ${dateFrom} to ${dateTo}`);
}

export async function fetchTransactionsCsv({ dateFrom, dateTo, fetchImpl = fetch, limit = 50, sleep = sleepDefault } = {}) {
  const startTimestamp = timestamp(dateFrom);
  const endTimestamp = timestamp(dateTo, true);
  const rows = [];
  const totalLimit = 5000;
  let total = null;
  for (let offset = 1; rows.length < (total ?? 1); offset += 1) {
    if (rows.length >= totalLimit) throw new Error('Amazon transaction result exceeds 5000 rows');
    const page = await fetchPage({ fetchImpl, startTimestamp, endTimestamp, offset, limit });
    const pageRows = page.tableRows || [];
    total = Number(page.tableMetadata?.numberOfRows ?? rows.length + pageRows.length);
    rows.push(...pageRows);
    if (!pageRows.length || rows.length >= total) break;
    await sleep(500);
  }
  const resultRows = rows.slice(0, total ?? rows.length);
  assertRowsWithinRequestedRange(resultRows, startTimestamp, endTimestamp, dateFrom, dateTo);
  return buildTransactionCsv(resultRows);
}
