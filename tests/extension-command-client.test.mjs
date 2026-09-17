import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentCommands, pollExtensionCommand, queueOrderImportCommand, queueAdsSpendCommand } from '../extensionCommandClient.js';

test('settlement range renews the command and reports aggregate imported rows', async () => {
  const calls = [];
  await pollExtensionCommand({
    base: 'https://example.test', token: 'test', client: { clientId: 'rdc', label: 'RDC' },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ data: url.endsWith('/claim')
        ? { command: { id: 'cmd', type: 'IMPORT_SETTLEMENTS', dateFrom: '2026-08-18', dateTo: '2026-09-17' }, leaseToken: 'lease' } : {} }) };
    },
    runSettlements: async ({ onProgress, activity, dateFrom }) => {
      assert.equal(dateFrom, '2026-08-18');
      assert.equal(typeof onProgress, 'function');
      assert.equal(activity.commandId, 'cmd');
      await onProgress({ stage: 'IMPORTING', batchId: 'batch' });
      return { importedCount: 950 };
    },
  });
  assert.equal(calls.at(-1).body.importedCount, 950);
  assert.equal(calls.filter(call => call.url.endsWith('/renew')).length, 1);
});

test('activity status lookup only reads the authenticated extension history', async () => {
  const items = await listAgentCommands({
    base: 'https://example.test/', token: 'test-token', client: { clientId: 'rdc-1', label: 'RDC 1' },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(new URL(url).pathname, '/api/integration/extension-commands/agent/commands');
      assert.equal(new URL(url).searchParams.get('clientId'), 'rdc-1');
      return { ok: true, json: async () => ({ data: { items: [{ id: 'cmd', status: 'FAILED' }] } }) };
    },
  });
  assert.deepEqual(items, [{ id: 'cmd', status: 'FAILED' }]);
});

test('a transaction lasting eight minutes completes with a continuously valid lease', async (t) => {
  let now = 1000000;
  let expiresAt = now + 300000;
  let renewals = 0;
  t.mock.method(Date, 'now', () => now);
  const outcome = await pollExtensionCommand({
    base: 'https://example.test', token: 'test', client: { clientId: 'rdc', label: 'RDC' },
    fetchImpl: async (url) => {
      if (url.endsWith('/renew') || url.endsWith('/complete')) assert.ok(now < expiresAt, 'lease expired during work');
      if (url.endsWith('/renew')) { expiresAt = now + 300000; renewals++; }
      return { ok: true, json: async () => ({ data: url.endsWith('/claim')
        ? { command: { id: 'cmd', type: 'IMPORT_TRANSACTIONS' }, leaseToken: 'lease' } : {} }) };
    },
    runTransactions: async ({ onProgress }) => {
      for (let pageNumber = 1; pageNumber <= 8; pageNumber++) {
        now += 60000;
        await onProgress({ stage: 'FETCHING', pageNumber });
      }
      return { processedRows: 80 };
    },
  });
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(renewals, 8);
});

test('sparse import progress stays inside the renewed lease including throttle margin', async (t) => {
  let now = 1000000;
  let expiresAt = now + 300000;
  t.mock.method(Date, 'now', () => now);
  const outcome = await pollExtensionCommand({
    base: 'https://example.test', token: 'test', client: { clientId: 'rdc', label: 'RDC' },
    fetchImpl: async url => {
      if (url.endsWith('/renew') || url.endsWith('/complete')) assert.ok(now < expiresAt);
      if (url.endsWith('/renew')) expiresAt = now + 420000;
      return { ok: true, json: async () => ({ data: url.endsWith('/claim')
        ? { command: { id: 'cmd', type: 'IMPORT_TRANSACTIONS' }, leaseToken: 'lease' } : {} }) };
    },
    runTransactions: async ({ onProgress }) => {
      await onProgress({ stage: 'IMPORTING', processedRows: 0 });
      now += 50000;
      await onProgress({ stage: 'IMPORTING', processedRows: 1 });
      now += 260000;
      await onProgress({ stage: 'IMPORTING', processedRows: 2 });
      return { processedRows: 2 };
    },
  });
  assert.equal(outcome.status, 'SUCCEEDED');
});

test('transaction progress renews its lease and retains batch identity on failure', async () => {
  const calls = [];
  await assert.rejects(pollExtensionCommand({
    base: 'https://example.test', token: 'test', client: { clientId: 'rdc', label: 'RDC' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      return { ok: true, json: async () => ({ data: url.endsWith('/claim')
        ? { command: { id: 'cmd', type: 'IMPORT_TRANSACTIONS' }, leaseToken: 'test-lease' } : {} }) };
    },
    runTransactions: async ({ onProgress }) => {
      assert.equal(typeof onProgress, 'function');
      await onProgress({ stage: 'FETCHING', pageNumber: 1 });
      await onProgress({ stage: 'IMPORTING', batchId: '507f1f77bcf86cd799439011', processedRows: 0 });
      throw new Error('Worker has not progressed');
    },
  }), /Worker has not progressed/);
  assert.equal(calls.filter(c => c.url.endsWith('/renew')).length, 2);
  assert.equal(calls.at(-1).body.importJobId, '507f1f77bcf86cd799439011');
});

test('a lost lease stops transaction work and preserves the original failure', async () => {
  let uploaded = false;
  await assert.rejects(pollExtensionCommand({
    base: 'https://example.test', token: 'test', client: { clientId: 'rdc', label: 'RDC' },
    fetchImpl: async url => ({ ok: !url.endsWith('/renew') && !url.endsWith('/complete'), status: 409,
      json: async () => url.endsWith('/claim') ? { data: { command: { id: 'cmd', type: 'IMPORT_TRANSACTIONS' }, leaseToken: 'lease' } }
        : { error: { message: url.endsWith('/renew') ? 'Lease lost' : 'Cannot complete' } } }),
    runTransactions: async ({ onProgress }) => { await onProgress({ stage: 'UPLOADING' }); uploaded = true; },
  }), /Lease lost/);
  assert.equal(uploaded, false);
});

test('queues the manual order import before claiming it', async () => {
  const calls = [];
  await queueOrderImportCommand({
    base: 'https://dev-api.lngmerch.co', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1', version: '0.3.0' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ success: true, data: { id: 'command-1', status: 'QUEUED' } }) };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /agent\/import-new-orders$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { clientId: 'rdc-1', label: 'RDC 1', version: '0.3.0', numDays: 1 });
});

test('queues a one-day Ads import before claiming it', async () => {
  const calls = [];
  await queueAdsSpendCommand({
    base: 'https://dev-api.lngmerch.co', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1', version: '0.3.0' }, date: '2026-08-23',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ success: true, data: { id: 'command-ads', status: 'QUEUED' } }) };
    },
  });

  assert.match(calls[0].url, /agent\/import-ads-spend$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { clientId: 'rdc-1', label: 'RDC 1', version: '0.3.0', dateFrom: '2026-08-23', dateTo: '2026-08-23' });
});

test('claims, runs, and completes an import command with the existing bearer token', async () => {
  const calls = [];
  const responses = [
    { success: true, data: { id: 'agent-1' } },
    { success: true, data: { command: { id: 'command-1', type: 'IMPORT_NEW_ORDERS' }, leaseToken: 'lease-token-1234567890' } },
    { success: true, data: { id: 'command-1', status: 'RUNNING' } },
    { success: true, data: { id: 'command-1', status: 'SUCCEEDED' } },
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => responses.shift() };
  };
  const result = await pollExtensionCommand({
    base: 'https://dev-api.lngmerch.co/', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1', version: '0.3.0' },
    runImport: async () => ({ result: { ingest: { data: { jobId: '507f1f77bcf86cd799439011' } }, rows: 3 } }), fetchImpl,
  });

  assert.deepEqual(result, { id: 'command-1', status: 'SUCCEEDED' });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer lng_ext_token');
  assert.match(calls[3].url, /commands\/command-1\/complete$/);
});

test('Orders command emits a keyed lifecycle through completion', async () => {
  const phases = [];
  const logger = {
    logTaskProcessing: async context => phases.push(['RUNNING', context.commandId]),
    logTaskCompleted: async context => phases.push(['SUCCEEDED', context.commandId]),
    logTaskFailed: async () => assert.fail('must not fail'),
  };
  await pollExtensionCommand({
    base: 'https://example.test', token: 'test', client: { clientId: 'rdc', label: 'RDC' }, logger,
    fetchImpl: async url => ({ ok: true, json: async () => ({ data: url.endsWith('/claim')
      ? { command: { id: 'order-1', type: 'IMPORT_NEW_ORDERS' }, leaseToken: 'lease' } : {} }) }),
    runImport: async (_, activity) => { assert.equal(activity.commandId, 'order-1'); return { rows: 1 }; },
  });
  assert.deepEqual(phases, [['RUNNING', 'order-1'], ['SUCCEEDED', 'order-1']]);
});

test('completes a connection-test command without running an Amazon import', async () => {
  const responses = [
    { success: true, data: { id: 'agent-1' } },
    { success: true, data: { command: { id: 'command-1', type: 'TEST_CONNECTION' }, leaseToken: 'lease-token-1234567890' } },
    { success: true, data: { id: 'command-1', status: 'RUNNING' } },
    { success: true, data: { id: 'command-1', status: 'SUCCEEDED' } },
  ];
  const result = await pollExtensionCommand({
    base: 'https://dev-api.lngmerch.co', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1' },
    runImport: async () => { throw new Error('Amazon must not be called'); },
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() }),
  });

  assert.deepEqual(result, { id: 'command-1', status: 'SUCCEEDED' });
});

test('runs an Ads command with its queued date range', async () => {
  const responses = [
    { success: true, data: { id: 'agent-1' } },
    { success: true, data: { command: { id: 'command-ads', type: 'IMPORT_ADS_SPEND', dateFrom: '2026-08-01', dateTo: '2026-08-22' }, leaseToken: 'lease-token-1234567890' } },
    { success: true, data: { id: 'command-ads', status: 'RUNNING' } },
    { success: true, data: { id: 'command-ads', status: 'SUCCEEDED' } },
  ];
  let dates;
  await pollExtensionCommand({
    base: 'https://dev-api.lngmerch.co', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1' },
    runImport: async () => { throw new Error('Orders must not be called'); },
    runAds: async (value) => { dates = value; return { result: { rows: 2 } }; },
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() }),
  });

  assert.deepEqual(dates, { dateFrom: '2026-08-01', dateTo: '2026-08-22' });
});

test('reports the backend error detail when heartbeat fails', async () => {
  await assert.rejects(
    pollExtensionCommand({
      base: 'http://localhost:5000', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1' }, runImport: async () => ({}),
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'Internal server error', requestId: 'req-1', stack: 'MongoServerError: duplicate key' } }) }),
    }),
    /MongoServerError: duplicate key \(request req-1\)/,
  );
});

test('forwards manual settlement dates and leaves scheduled discovery undated', async () => {
  for (const dates of [{ dateFrom: '2026-09-01', dateTo: '2026-09-14' }, {}]) {
    const responses = [
      { data: { id: 'agent-1' } },
      { data: { command: { id: 'settlement-1', type: 'IMPORT_SETTLEMENTS', ...dates }, leaseToken: 'lease-token' } },
      { data: {} }, { data: {} },
    ];
    let received;
    await pollExtensionCommand({
      base: 'https://dev-api.lngmerch.co', token: 'test-token', client: { clientId: 'rdc-1', label: 'RDC 1' },
      runSettlements: async (input) => { received = input; return { rows: 1 }; },
      fetchImpl: async () => ({ ok: true, json: async () => responses.shift() }),
    });
    assert.equal(received.dateFrom, dates.dateFrom);
    assert.equal(received.dateTo, dates.dateTo);
  }
});
