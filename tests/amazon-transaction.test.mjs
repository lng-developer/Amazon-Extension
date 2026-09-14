import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransactionCsv, fetchTransactionsCsv, summarizeTransactionCsv } from '../amazonTransaction.js';

const page = (pageNumber, rows, numberOfRows = rows.length) => ({
  tableMetadata: { numberOfRows, pageNumber },
  tableRows: rows,
});

const row = (date = 1788764176829) => ({
  tableCells: [
    { columnIdentifier: 'POSTED_DATE', value: { type: 'LocalizedDate', dateEpochMillis: date } },
    { columnIdentifier: 'TRANSACTION_STATUS', value: { type: 'PlainText', textContent: 'Released' } },
    { columnIdentifier: 'TRANSACTION_TYPE', value: { type: 'PlainText', textContent: 'Order Payment' } },
    { columnIdentifier: 'ORDER_ID', value: { type: 'PlainText', textContent: '123' } },
    { columnIdentifier: 'DESCRIPTION', value: { type: 'PlainText', textContent: 'Name, custom' } },
    { columnIdentifier: 'PRODUCT_CHARGES', value: { type: 'LocalizedCurrency', currency: { amount: 47.6, unit: 'USD' } } },
    { columnIdentifier: 'PROMO_REBATES', value: { type: 'LocalizedCurrency', currency: { amount: 0, unit: 'USD' } } },
    { columnIdentifier: 'FEES_TOTAL', value: { type: 'LocalizedCurrency', currency: { amount: -2.74, unit: 'USD' } } },
    { columnIdentifier: 'OTHER_TOTAL', value: { type: 'LocalizedCurrency', currency: { amount: 7, unit: 'USD' } } },
    { columnIdentifier: 'TOTAL', value: { type: 'Link', linkBody: { type: 'LocalizedCurrency', currency: { amount: 51.86, unit: 'USD' } } } },
  ],
});

test('maps Amazon transaction cells to the downloadable CSV columns', () => {
  assert.equal(buildTransactionCsv([row()]), [
    '"Date","Transaction Status","Transaction type","Order ID","Product Details","Total product charges","Total promotional rebates","Amazon fees","Other","Total (USD)"',
    '"9/7/2026","Released","Order Payment","123","Name, custom","47.60","0.00","-2.74","7.00","51.86"',
  ].join('\n'));
});

test('fetches all pages sequentially and returns one CSV', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const pageNumber = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, json: async () => page(pageNumber, [row(Date.UTC(2026, 8, 6, 12))], 2) };
  };

  const csv = await fetchTransactionsCsv({ dateFrom: '2026-09-06', dateTo: '2026-09-07', fetchImpl, limit: 1, sleep: async () => {} });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /offset=2/);
  assert.equal(csv.split('\n').length, 3);
  const request = new URL(calls[0]);
  assert.equal(request.searchParams.get('fiqFiltersString'), '(startTimestamp==1788627600000);(endTimestamp==1788800399999)');
});

test('rejects an Amazon response with posted dates outside the requested range', async () => {
  await assert.rejects(
    fetchTransactionsCsv({
      dateFrom: '2026-09-13',
      dateTo: '2026-09-13',
      fetchImpl: async () => ({ ok: true, json: async () => page(1, [row(Date.UTC(2026, 4, 23))]) }),
      sleep: async () => {},
    }),
    /Amazon returned transactions outside requested date range: 2026-09-13 to 2026-09-13/,
  );
});

test('uses Amazon Payments default page size', async () => {
  const calls = [];
  await fetchTransactionsCsv({
    dateFrom: '2026-09-13',
    dateTo: '2026-09-13',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => page(1, [], 0) };
    },
  });
  assert.equal(new URL(calls[0]).searchParams.get('limit'), '10');
});

test('fails a transaction request that does not receive an Amazon response', async () => {
  await assert.rejects(
    fetchTransactionsCsv({
      dateFrom: '2026-09-13',
      dateTo: '2026-09-13',
      timeoutMs: 1,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        const pending = setTimeout(() => reject(new Error('fetch stayed pending')), 10);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(pending);
          reject(new Error('request aborted'));
        }, { once: true });
      }),
    }),
    /Amazon transaction request timed out/,
  );
});

test('fails when Amazon sends headers but its response body stays pending', async () => {
  let signal;
  await assert.rejects(
    fetchTransactionsCsv({
      dateFrom: '2026-09-13',
      dateTo: '2026-09-13',
      timeoutMs: 1,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return {
          ok: true,
          json: () => new Promise((_resolve, reject) => {
            const pending = setTimeout(() => reject(new Error('response body stayed pending')), 10);
            signal.addEventListener('abort', () => {
              clearTimeout(pending);
              reject(new Error('request aborted'));
            }, { once: true });
          }),
        };
      },
    }),
    /Amazon transaction request timed out/,
  );
});

test('summarizes the fetched CSV without logging transaction contents', () => {
  const summary = summarizeTransactionCsv(buildTransactionCsv([
    row(Date.UTC(2026, 8, 14)),
    row(Date.UTC(2026, 8, 13)),
  ]));

  assert.deepEqual(summary, {
    rowCount: 2,
    postedDateMin: '2026-09-13',
    postedDateMax: '2026-09-14',
  });
});
