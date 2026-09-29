import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, validateTrackingPayload } from '../amazonTrackingUpload.js';
import { extractFeedHistoryIds } from '../amazonFeedHistory.js';

const tsv = 'order-id\tship-date\tcarrier-code\ttracking-number\tship-method\r\n114-1234567-1234567\t2026-09-28\tUSPS\t9400\tStandard\r\n';

test('accepts only an exact checksum-bound tracking TSV', async () => {
  await assert.doesNotReject(validateTrackingPayload({ tsv, checksum: await sha256(tsv), rowCount: 1 }));
  await assert.rejects(validateTrackingPayload({ tsv, checksum: '0'.repeat(64), rowCount: 1 }), /checksum/);
});

test('extracts stable candidate ids from Feed History rows', () => {
  assert.deepEqual(extractFeedHistoryIds(['Feed ID 123456789 complete', '123456789 duplicate']), ['123456789']);
});
