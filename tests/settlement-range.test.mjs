import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as settlement from '../amazonSettlement.js';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
function load(name, end, globals) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must be implemented`);
  return vm.runInNewContext(`${source.slice(start, source.indexOf(end, start))}; ${name}`, globals);
}

test('range selection includes overlapping closed periods, deduplicates, and excludes open periods', () => {
  assert.equal(typeof settlement.selectSettlementRange, 'function');
  const row = (id, periodText) => ({ href: `https://sellercentral.amazon.com/payments/reports/download?referenceId=${id}`, isFlatFileV2: true, periodText });
  const selected = settlement.selectSettlementRange([
    row('4', '9/6/2026 – Present'), row('3', '9/5/2026 – 9/6/2026'),
    row('2', '8/29/2026 – 9/3/2026'), row('1', '8/10/2026 – 8/19/2026'),
    row('0', '8/1/2026 – 8/10/2026'), row('2', '8/29/2026 – 9/3/2026'),
  ], { dateFrom: '2026-08-18', dateTo: '2026-09-17' });
  assert.deepEqual(selected.map(row => row.referenceId), ['1', '2', '3']);
  assert.equal(selected[0].dateFrom, '2026-08-10');
  assert.throws(() => settlement.selectSettlementRange([], { dateFrom: 'bad', dateTo: '2026-09-17' }), /date/i);
});

test('range imports sequentially, retains whole periods, and sums only completed imports', async () => {
  const seen = [];
  const run = load('runSettlementRange', 'async function runScheduledSettlementImport', {
    settlementRangeRunning: false, settlementImportLock: { running: false },
    findSettlementRange: async () => [
      { referenceId: 'a', dateFrom: '2026-08-10', dateTo: '2026-08-19' },
      { referenceId: 'b', dateFrom: '2026-08-19', dateTo: '2026-09-01' },
    ],
    extensionLogger: { logInfo: async () => {} },
    runImportSettlements: async input => {
      seen.push(input.dateFrom);
      return input.descriptor.referenceId === 'a'
        ? { skipped: true, reason: 'SETTLEMENT_ALREADY_IMPORTED' } : { processedRows: 12 };
    },
  });
  const result = await run({ dateFrom: '2026-08-18', dateTo: '2026-09-17' });
  assert.deepEqual(seen, ['2026-08-10', '2026-08-19']);
  assert.equal(result.importedCount, 12);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.statementCount, 2);
});

test('range does not report success for cooldown or an empty discovery', async () => {
  let rows = [{ referenceId: 'a' }];
  const run = load('runSettlementRange', 'async function runScheduledSettlementImport', {
    settlementRangeRunning: false, settlementImportLock: { running: false },
    findSettlementRange: async () => rows,
    extensionLogger: { logInfo: async () => {} },
    runImportSettlements: async () => ({ skipped: true, reason: 'SETTLEMENT_COOLDOWN' }),
  });
  await assert.rejects(run({}), /cooldown/i);
  rows = [];
  await assert.rejects(run({}), /no.*settlement/i);
});

test('discovery starts on a fresh tab, visits all pages, and closes only its own tab', async () => {
  let page = 0;
  const removed = [];
  const find = load('findSettlementRange', 'async function fetchSettlementsTxtFromAmazon', {
    selectSettlementRange: settlement.selectSettlementRange,
    ALL_STATEMENTS_URL: 'https://sellercentral.amazon.com/payments/past-settlements',
    SC_BASE: 'https://sellercentral.amazon.com',
    waitForTabComplete: async () => {}, inspectSettlementRangePage: () => {},
    chrome: {
      tabs: {
        create: async input => { assert.equal(input.active, false); return { id: 42 }; },
        get: async () => ({ url: 'https://sellercentral.amazon.com/payments/past-settlements' }),
        remove: async id => removed.push(id),
      },
      scripting: { executeScript: async ({ args }) => {
        if (args[0].advance) page++;
        return [{ result: { hasNext: page === 0, candidates: [{
          href: `https://sellercentral.amazon.com/payments/reports/download?referenceId=${page}`,
          isFlatFileV2: true, periodText: page ? '8/10/2026 – 8/19/2026' : '9/5/2026 – 9/6/2026',
        }] } }];
      } },
    },
  });
  const result = await find({ dateFrom: '2026-08-18', dateTo: '2026-09-17' });
  assert.equal(page, 1);
  assert.deepEqual(result.map(row => row.referenceId), ['1', '0']);
  assert.deepEqual(removed, [42]);
});

test('page inspection reads shadow DOM download buttons, skips open periods, and advances', async () => {
  let page = 0;
  const row = (text, id) => {
    const button = { matches: selector => selector === 'button[data-action]', getAttribute: name => name === 'data-action' ? id : null, querySelectorAll: () => [] };
    const dropdown = { matches: () => false, getAttribute: () => null, querySelectorAll: () => [], shadowRoot: { querySelectorAll: () => [button] } };
    return { innerText: text, matches: selector => selector === 'tr,[role="row"]', querySelectorAll: () => [dropdown], getAttribute: () => null };
  };
  const pages = [[row('9/6/2026 – Present', '9'), row('9/5/2026 – 9/6/2026', '8')], [row('8/10/2026 – 8/19/2026', '7')]];
  const next = { matches: selector => selector === 'button,a,[role="button"]', getAttribute: name => name === 'aria-label' ? 'Next page' : null,
    closest: () => page ? {} : null, click: () => { page++; } };
  const inspect = load('inspectSettlementRangePage', 'async function findSettlementRange', {
    document: { querySelectorAll: () => [...pages[page], next] },
    location: { origin: 'https://sellercentral.amazon.com' }, URL, URLSearchParams, setTimeout,
  });
  const first = await inspect({ dateFrom: '2026-08-18', dateTo: '2026-09-17' });
  assert.equal(first.candidates.length, 1);
  assert.equal(new URL(first.candidates[0].href).searchParams.get('referenceId'), '8');
  assert.equal(first.hasNext, true);
  const second = await inspect({ dateFrom: '2026-08-18', dateTo: '2026-09-17', advance: true });
  assert.equal(second.hasNext, false);
  assert.equal(new URL(second.candidates[0].href).searchParams.get('referenceId'), '7');
});

test('dispatcher chooses range for dated commands and retains scheduled discovery', async () => {
  const run = load('pollExtensionCommands', 'async function queueManualOrderImport', {
    extensionLogger: {}, getBaseShopAndIdentity: async () => ({ base: 'test' }),
    chrome: { runtime: { getManifest: () => ({ version: 'test' }) } },
    runImportTransactions: () => {},
    pollExtensionCommand: async ({ runSettlements }) => [await runSettlements({ dateFrom: '2026-08-18', dateTo: '2026-09-17' }), await runSettlements({})],
    runSettlementRange: async () => 'range', runScheduledSettlementImport: async () => 'scheduled',
  });
  assert.deepEqual(await run({ ingestToken: 'test' }), ['range', 'scheduled']);
});

test('an already processing statement resumes monitoring without another upload', async () => {
  let status = 'PROCESSING';
  let waited = 0;
  const run = load('runImportSettlements', 'async function runSettlementRange', {
    settlementImportLock: { running: false }, settlementRangeRunning: true,
    getCfg: async () => ({ ingestUrl: 'https://test', ingestToken: 'test' }),
    extensionLogger: { logTaskProcessing: async () => {}, logInfo: async () => {}, logTaskFailed: async () => {} },
    deriveApiUrls: () => ({ base: 'https://test' }),
    sha256Key: async value => { assert.equal(value, 'SETTLEMENT_HISTORY|https://test|test|a'); return 'scoped-a'; },
    getJson: async () => ({ data: { completed: false } }),
    settlementImportDecision: settlement.settlementImportDecision,
    readSettlementImportHistory: async () => ({ 'scoped-a': { status, batchId: 'batch', rowCount: 12 }, a: { status: 'PROCESSING', batchId: 'wrong-environment' } }),
    recordSettlementImport: async (key, entry) => { assert.equal(key, 'scoped-a'); status = entry.status; },
    waitForFinanceImport: async ({ batchId, onProgress }) => {
      assert.equal(batchId, 'batch');
      await onProgress({ stage: 'IMPORTING', batchId });
      waited++;
      return { status: 'COMPLETED', processedRows: 12 };
    },
  });
  const result = await run({ dateFrom: '2026-09-05', dateTo: '2026-09-06', descriptor: { referenceId: 'a' }, rangeTask: true, activity: { commandId: 'cmd' } });
  assert.equal(waited, 1);
  assert.equal(status, 'COMPLETED');
  assert.equal(result.processedRows, 12);
});

test('range stops on an import failure and preserves completed row counts', async () => {
  let calls = 0;
  const run = load('runSettlementRange', 'async function runScheduledSettlementImport', {
    settlementRangeRunning: false, settlementImportLock: { running: false },
    findSettlementRange: async () => [{ referenceId: 'a' }, { referenceId: 'b' }, { referenceId: 'c' }],
    extensionLogger: { logInfo: async () => {} },
    runImportSettlements: async () => { calls++; if (calls === 2) throw new Error('network'); return { processedRows: 12 }; },
  });
  await assert.rejects(run({}), error => error.message === 'network' && error.importedCount === 12);
  assert.equal(calls, 2);
});
