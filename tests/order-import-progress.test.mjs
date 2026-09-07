import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderImportProgress } from '../orderImportProgress.js';

test('stores a durable order-import progress snapshot', () => {
  const progress = createOrderImportProgress('WAITING_FOR_REPORT', 'Waiting for Amazon report', { attempt: 2 });

  assert.equal(progress.state, 'WAITING_FOR_REPORT');
  assert.equal(progress.message, 'Waiting for Amazon report');
  assert.equal(progress.attempt, 2);
  assert.equal(typeof progress.updatedAt, 'number');
});
