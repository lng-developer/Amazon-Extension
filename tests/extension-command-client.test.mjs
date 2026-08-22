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

test('reports the backend error detail when heartbeat fails', async () => {
  await assert.rejects(
    pollExtensionCommand({
      base: 'http://localhost:5000', token: 'lng_ext_token', client: { clientId: 'rdc-1', label: 'RDC 1' }, runImport: async () => ({}),
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'Internal server error', requestId: 'req-1', stack: 'MongoServerError: duplicate key' } }) }),
    }),
    /MongoServerError: duplicate key \(request req-1\)/,
  );
});
