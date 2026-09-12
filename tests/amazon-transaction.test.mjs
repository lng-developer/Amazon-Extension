import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransactionCsv, fetchTransactionsCsv } from '../amazonTransaction.js';

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
    return { ok: true, json: async () => page(pageNumber, [row(pageNumber)], 2) };
  };

  const csv = await fetchTransactionsCsv({ dateFrom: '2026-09-06', dateTo: '2026-09-07', fetchImpl, limit: 1, sleep: async () => {} });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /offset=2/);
  assert.equal(csv.split('\n').length, 3);
});
