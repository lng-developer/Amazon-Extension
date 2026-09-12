import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOneOffReportConfig,
  isTerminalReportStatus,
  shouldFailReportStatus,
} from '../adsReporting.js';

const template = {
  reportConfigurationId: 'template-id',
  creationDateTime: '2026-08-24T00:00:00Z',
  latestScheduledReportStatus: 'COMPLETED',
  linkedQuery: { reportingQuery: { fields: ['date.value', 'campaign.name', 'metric.totalCost'] } },
  format: 'CSV',
  linkedAccounts: [{ advertiserAccountId: 'account-id' }],
  period: { datePeriod: { startDate: '2026-08-01', endDate: '2026-08-01' } },
};

test('builds a one-day CSV report without retained report state', () => {
  const report = buildOneOffReportConfig(template, '2026-08-20');

  assert.equal(report.period.datePeriod.startDate, '2026-08-20');
  assert.equal(report.period.datePeriod.endDate, '2026-08-20');
  assert.equal(report.format, 'CSV');
  assert.equal(report.reportConfigurationId, undefined);
  assert.equal(report.latestScheduledReportStatus, undefined);
  assert.equal(report.scheduleType, 'NOW');
});

test('recognizes report terminal states', () => {
  assert.equal(isTerminalReportStatus('COMPLETED'), true);
  assert.equal(isTerminalReportStatus('SCHEDULED'), false);
  assert.equal(shouldFailReportStatus('FAILED'), true);
  assert.equal(shouldFailReportStatus('COMPLETED'), false);
});
