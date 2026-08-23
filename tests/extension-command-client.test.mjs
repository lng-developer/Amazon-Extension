import assert from 'node:assert/strict';
import test from 'node:test';
import { pollExtensionCommand } from '../extensionCommandClient.js';

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

test('runs an ads import with the date range from the claimed command', async () => {
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
