import assert from 'node:assert/strict';
import test from 'node:test';

import { getJson, postFileTo } from '../backendApi.js';

test('status and upload requests have an abort deadline', async () => {
  const previousFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (_, options) => {
    signals.push(options.signal);
    return { ok: true, text: async () => '{}' };
  };
  try {
    await getJson('https://example.test/batch', 'test');
    await postFileTo('https://example.test/upload', { file: 'csv' }, 'test');
    assert.equal(signals.length, 2);
    for (const signal of signals) assert.ok(signal instanceof AbortSignal);
  } finally { globalThis.fetch = previousFetch; }
});

test('postFileTo preserves the backend error message', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ success: false, error: { message: 'Forbidden' } }),
  });

  try {
    await assert.rejects(
      () => postFileTo('https://dev-api.example.test/import', { file: 'x' }, 'token'),
      /Backend 403: Forbidden/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
