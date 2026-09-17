import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionIdentity } from '../extensionIdentity.js';

test('shares one generated client identity across concurrent initialization', async () => {
  const values = {};
  let generated = 0;
  const storage = {
    async get() { return { ...values }; },
    async set(next) { Object.assign(values, next); },
  };
  const ensureIdentity = createExtensionIdentity({ storage, randomUUID: () => `id-${++generated}` });

  const [first, second] = await Promise.all([ensureIdentity(), ensureIdentity()]);

  assert.deepEqual(first, { clientId: 'ext-id-1', clientLabel: 'Chrome t-id-1' });
  assert.deepEqual(second, first);
  assert.equal(generated, 1);
  assert.deepEqual(values, first);
});
