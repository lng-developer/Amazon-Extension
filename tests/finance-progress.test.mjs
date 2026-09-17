import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
function load(name, end, globals) {
  const start = source.indexOf(`async function ${name}(`);
  return vm.runInNewContext(`${source.slice(start, source.indexOf(end, start))}; ${name}`, { crypto: globalThis.crypto, extensionLogger: {}, ...globals });
}

test('Amazon wrapper forwards page progress to the task', async () => {
  let seen = false;
  const fetchCsv = load('fetchTransactionsCsvFromAmazon', 'async function sha256Key', {
    fetchAmazonTransactionsCsv: async ({ onPage }) => { await onPage({ pageNumber: 1 }); return 'csv'; },
  });
  await fetchCsv({ dateFrom: '2026-09-15', dateTo: '2026-09-16', onPage: async () => { seen = true; } });
  assert.equal(seen, true);
});

test('command dispatcher forwards the progress callback all the way into the transaction task', async () => {
  const progress = async () => {};
  const poll = load('pollExtensionCommands', 'async function queueManualOrderImport', {
    getBaseShopAndIdentity: async () => ({ base: 'test', clientId: 'rdc', clientLabel: 'RDC' }),
    chrome: { runtime: { getManifest: () => ({ version: 'test' }) } },
    pollExtensionCommand: async ({ runTransactions }) => runTransactions({ dateFrom: '2026-09-15', dateTo: '2026-09-16', onProgress: progress }),
    runImportTransactions: async (input) => { assert.equal(input.onProgress, progress); return 'forwarded'; },
  });
  assert.equal(await poll({ ingestToken: 'test' }), 'forwarded');
});

test('a network failure after upload retains the batch for a later resume', async () => {
  const stored = {};
  let uploads = 0;
  let reads = 0;
  let fail = true;
  const run = load('runImportTransactions', 'async function runImportSettlements', {
    transactionImportRunning: false,
    getCfg: async () => ({ ingestUrl: 'https://test', ingestToken: 'token' }),
    sha256Key: async () => 'scope-hash',
    chrome: { storage: { local: { get: async () => stored, set: async data => Object.assign(stored, data), remove: async key => { delete stored[key]; } } } },
    extensionLogger: { logTaskProcessing: async () => {}, logInfo: async () => {}, logTaskCompleted: async () => {}, logTaskFailed: async () => {} },
    deriveApiUrls: () => ({ base: 'https://test', transactionsImportUrl: 'https://test/upload' }),
    summarizeTransactionCsv: () => ({ rowCount: 17 }),
    fetchTransactionsCsvFromAmazon: async ({ onPage }) => { reads++; await onPage({ pageNumber: 1 }); return 'csv'; },
    postFileTo: async () => { uploads++; return { data: { importBatchId: 'batch-17' } }; },
    waitForFinanceImport: async () => { if (fail) throw new Error('Network unavailable'); return { status: 'COMPLETED' }; },
  });
  await assert.rejects(run({ dateFrom: '2026-09-15', dateTo: '2026-09-16' }), error => error.batchId === 'batch-17');
  assert.equal(stored['transactionBatch:scope-hash'], 'batch-17');
  fail = false;
  await run({ dateFrom: '2026-09-15', dateTo: '2026-09-16' });
  assert.equal(uploads, 1);
  assert.equal(reads, 1);
});

test('batch with no progress stops waiting and reports its retained id', async () => {
  let now = 0;
  const logs = [];
  let renewals = 0;
  const wait = load('waitForFinanceImport', 'async function extractSettlementDownloadCandidates', {
    Date: { now: () => now },
    financeImportSleep: async ms => { now += ms; },
    getJson: async () => ({ data: { status: 'PROCESSING', processedRows: 0 } }),
    extensionLogger: { logInfo: async (_, info) => logs.push(info) },
  });
  await assert.rejects(wait({ base: 'test', batchId: 'batch-17', token: '', context: {}, progressTimeoutMs: 300000, onProgress: async () => { renewals++; } }), error => {
    assert.equal(error.batchId, 'batch-17');
    assert.match(error.message, /no progress/i);
    return true;
  });
  assert.ok(now <= 310000);
  assert.ok(logs.length > 1, 'waiting should remain observable even when status is unchanged');
  assert.equal(renewals, 1, 'unchanged polls must not renew the lease');
});

test('shared settlement waiter retains its previous budget without row progress', async () => {
  let now = 0;
  const wait = load('waitForFinanceImport', 'async function extractSettlementDownloadCandidates', {
    Date: { now: () => now },
    financeImportSleep: async ms => { now += ms; },
    getJson: async () => ({ data: { status: now >= 360000 ? 'COMPLETED' : 'PROCESSING', processedRows: 0 } }),
    extensionLogger: { logInfo: async () => {} },
  });
  assert.equal((await wait({ base: 'test', batchId: 'settlement', kind: 'Settlement', context: {} })).status, 'COMPLETED');
});

test('terminal batch failures are distinguished from resumable waits', async () => {
  for (const batch of [{ status: 'FAILED' }, { status: 'PARTIAL_FAILED' }, { status: 'COMPLETED', recalculationStatus: 'PARTIAL_FAILED' }]) {
    const wait = load('waitForFinanceImport', 'async function extractSettlementDownloadCandidates', {
      Date, getJson: async () => ({ data: batch }), extensionLogger: { logInfo: async () => {} },
    });
    await assert.rejects(wait({ base: 'test', batchId: 'failed-batch', context: {} }), e => e.terminalBatch === true);
  }
});

test('terminal failure clears the local resume pointer', async () => {
  let removed;
  const run = load('runImportTransactions', 'async function runImportSettlements', {
    transactionImportRunning: false,
    getCfg: async () => ({ ingestUrl: 'https://test', ingestToken: 'token' }),
    sha256Key: async () => 'scope-hash',
    chrome: { storage: { local: { get: async () => ({ 'transactionBatch:scope-hash': 'batch-17' }), remove: async key => { removed = key; } } } },
    extensionLogger: { logTaskProcessing: async () => {}, logInfo: async () => {}, logTaskFailed: async () => {} },
    deriveApiUrls: () => ({ base: 'https://test' }),
    waitForFinanceImport: async () => { throw Object.assign(new Error('FAILED'), { terminalBatch: true }); },
  });
  await assert.rejects(run({ dateFrom: '2026-09-15', dateTo: '2026-09-16' }), /FAILED/);
  assert.equal(removed, 'transactionBatch:scope-hash');
});

test('advancing rows can finish beyond the old polling budget', async () => {
  let now = 0;
  const progress = [];
  const wait = load('waitForFinanceImport', 'async function extractSettlementDownloadCandidates', {
    Date: { now: () => now },
    financeImportSleep: async ms => { now += ms; },
    getJson: async () => ({ data: { status: now >= 900000 ? 'COMPLETED' : 'PROCESSING', processedRows: Math.floor(now / 10000) } }),
    extensionLogger: { logInfo: async () => {} },
  });
  const result = await wait({ base: 'test', batchId: 'batch-17', token: '', context: {}, progressTimeoutMs: 300000, onProgress: async p => progress.push(p) });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(progress.length > 80);
});

test('restarting a transaction task resumes its batch without downloading or uploading again', async () => {
  let removed;
  const run = load('runImportTransactions', 'async function runImportSettlements', {
    transactionImportRunning: false,
    getCfg: async () => ({ ingestUrl: 'https://test', ingestToken: 'token' }),
    sha256Key: async () => 'scope-hash',
    chrome: { storage: { local: { get: async () => ({ 'transactionBatch:scope-hash': 'batch-17' }), remove: async key => { removed = key; } } } },
    extensionLogger: { logTaskProcessing: async () => {}, logInfo: async () => {}, logTaskCompleted: async () => {}, logTaskFailed: async () => {} },
    deriveApiUrls: () => ({ base: 'https://test', transactionsImportUrl: 'https://test/upload' }),
    fetchTransactionsCsvFromAmazon: async () => { throw new Error('Must not download again'); },
    waitForFinanceImport: async ({ batchId }) => { assert.equal(batchId, 'batch-17'); return { status: 'COMPLETED' }; },
  });
  assert.equal((await run({ dateFrom: '2026-09-15', dateTo: '2026-09-16' })).status, 'COMPLETED');
  assert.equal(removed, 'transactionBatch:scope-hash');
});
