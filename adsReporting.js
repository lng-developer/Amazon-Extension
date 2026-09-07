export const REPORT_POLL_INTERVAL_MS = 10_000;
export const REPORT_POLL_MAX_ATTEMPTS = 18;

const REPORT_STATE_KEYS = new Set([
  'reportConfigurationId',
  'creationDateTime',
  'lastUpdatedDateTime',
  'latestScheduledReportFailureCode',
  'latestScheduledReportId',
  'latestScheduledReportLastUpdatedDateTime',
  'latestScheduledReportStatus',
]);

export function isTerminalReportStatus(status) {
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(String(status || '').toUpperCase());
}

export function shouldFailReportStatus(status) {
  return ['FAILED', 'CANCELLED', 'EXPIRED'].includes(String(status || '').toUpperCase());
}

export function findCsvReportTemplate(configurations = []) {
  return configurations.find((configuration) => (
    configuration?.format === 'CSV'
    && Array.isArray(configuration?.linkedQuery?.reportingQuery?.fields)
    && configuration.linkedQuery.reportingQuery.fields.includes('campaign.name')
    && configuration.linkedQuery.reportingQuery.fields.includes('metric.totalCost')
  )) || null;
}

export function buildOneOffReportConfig(template, reportDate) {
  if (!template?.linkedQuery || !template?.linkedAccounts?.length) {
    throw new Error('Amazon Ads CSV report template is unavailable. Create a Campaign CSV report with Campaign name and Total cost first.');
  }

  const report = Object.fromEntries(Object.entries(template)
    .filter(([key]) => !REPORT_STATE_KEYS.has(key)));
  return {
    ...report,
    name: `LNG Ads ${reportDate}`,
    period: { datePeriod: { startDate: reportDate, endDate: reportDate } },
    schedule: { nowSchedule: { timeZone: 'ASIA_BANGKOK' } },
    scheduleType: 'NOW',
    status: 'ACTIVE',
  };
}

export function reportConfigurationId(response) {
  return response?.success?.[0]?.reportConfiguration?.reportConfigurationId
    || response?.reportConfiguration?.reportConfigurationId
    || null;
}
