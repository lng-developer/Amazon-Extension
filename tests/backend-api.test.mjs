import assert from 'node:assert/strict';
import test from 'node:test';

import { postFileTo } from '../backendApi.js';

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
