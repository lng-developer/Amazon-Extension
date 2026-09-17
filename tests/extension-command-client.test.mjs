import assert from 'node:assert/strict';
import test from 'node:test';
import { pollExtensionCommand, queueOrderImportCommand, queueAdsSpendCommand } from '../extensionCommandClient.js';

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
    assert.deepEqual(received, { dateFrom: dates.dateFrom, dateTo: dates.dateTo });
  }
});
