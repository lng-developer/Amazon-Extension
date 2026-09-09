import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SETTLEMENT_IMPORT_COOLDOWN_MS,
  canStartSettlementImport,
  parseStatementPeriod,
  settlementImportDecision,
  selectSettlementDownload,
  validateSettlementText,
} from '../amazonSettlement.js';

const candidates = [
  { href: 'https://sellercentral.amazon.com/payments/reports/download?referenceId=one&contentType=text%2Fxls&fileName=one.txt', isFlatFileV2: true, periodText: '8/1/2026 – 8/15/2026' },
  { href: 'https://sellercentral.amazon.com/payments/reports/download?referenceId=two&contentType=text%2Fxls&fileName=two.txt', isFlatFileV2: true, periodText: '7/18/2026 – 8/1/2026' },
  { href: 'https://sellercentral.amazon.com/payments/reports/download?referenceId=three&contentType=text%2Fxls&fileName=three.txt', isFlatFileV2: true, periodText: '5/23/2026 – 7/18/2026' },
];

test('parses Amazon statement period labels into ISO dates', () => {
  assert.deepEqual(parseStatementPeriod('7/18/2026 – 8/1/2026'), {
    dateFrom: '2026-07-18',
    dateTo: '2026-08-01',
  });
});

test('selects only the exact settlement period and never the first visible row', () => {
  assert.equal(
    selectSettlementDownload(candidates, { dateFrom: '2026-07-18', dateTo: '2026-08-01' }).href,
    candidates[1].href,
  );
});

test('rejects missing or ambiguous settlement periods', () => {
  assert.throws(
    () => selectSettlementDownload(candidates, { dateFrom: '2026-05-01', dateTo: '2026-05-22' }),
    /not found/,
  );
  assert.throws(
    () => selectSettlementDownload([
      ...candidates,
      { href: 'https://sellercentral.amazon.com/payments/reports/download?referenceId=duplicate&contentType=text%2Fxls&fileName=duplicate.txt', isFlatFileV2: true, periodText: '7/18/2026 – 8/1/2026' },
    ], { dateFrom: '2026-07-18', dateTo: '2026-08-01' }),
    /ambiguous/,
  );
});

test('validates a settlement flat file before upload', () => {
  const text = [
    'settlement-id\tsettlement-start-date\tsettlement-end-date\tdeposit-date\ttotal-amount\tcurrency\ttransaction-type\tamount-type\tamount',
    '27554249931\t2026-09-05 03:05:26 UTC\t2026-09-06 16:37:16 UTC\t2026-09-08 16:37:16 UTC\t962.15\tUSD\tOrder\tItemPrice\t35.80',
  ].join('\n');

  assert.equal(validateSettlementText(text).rowCount, 1);
  assert.throws(() => validateSettlementText('<html>login</html>'), /invalid settlement file/i);
});

test('blocks repeated settlement downloads during the cooldown', () => {
  const now = 1_000_000;
  assert.equal(canStartSettlementImport({ attemptedAt: now - 1_000 }, now), false);
  assert.equal(canStartSettlementImport({ attemptedAt: now - SETTLEMENT_IMPORT_COOLDOWN_MS }, now), true);
  assert.equal(canStartSettlementImport(null, now), true);
});

test('skips a settlement that LNG already completed before download', () => {
  assert.deepEqual(
    settlementImportDecision({ completed: true, referenceId: '27554249931' }),
    { ok: true, skipped: true, reason: 'SETTLEMENT_ALREADY_IMPORTED', referenceId: '27554249931' },
  );
  assert.equal(settlementImportDecision({ completed: false, referenceId: '27554249931' }), null);
});
