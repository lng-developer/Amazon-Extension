import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, validateTrackingPayload } from '../amazonTrackingUpload.js';
import { extractFeedHistoryIds, findNewFeedRow, terminalFeedResult } from '../amazonFeedHistory.js';

const tsv = 'order-id\tship-date\tcarrier-code\ttracking-number\tship-method\r\n114-1234567-1234567\t2026-09-28\tUSPS\t9400\tStandard\r\n';

test('accepts only an exact checksum-bound tracking TSV', async () => {
  await assert.doesNotReject(validateTrackingPayload({ tsv, checksum: await sha256(tsv), rowCount: 1 }));
  await assert.rejects(validateTrackingPayload({ tsv, checksum: '0'.repeat(64), rowCount: 1 }), /checksum/);
});

test('extracts stable candidate ids from Feed History rows', () => {
  assert.deepEqual(extractFeedHistoryIds(['Feed ID 123456789 complete', '123456789 duplicate']), ['123456789']);
});

test('waits when Feed History has no unique new row and recognizes terminal results', () => {
  assert.equal(findNewFeedRow(['123456789 DONE', '987654321 PROCESSING'], ['123456789']), '987654321 PROCESSING');
  assert.equal(findNewFeedRow(['123456789 DONE', '987654321 PROCESSING'], []), null);
  assert.equal(terminalFeedResult('987654321 DONE').status, 'SUCCEEDED');
});
