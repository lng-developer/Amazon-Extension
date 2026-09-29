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

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function listAdsReportDates(dateFrom, dateTo) {
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) throw new Error('dateFrom and dateTo must be ISO dates');
  if (dateFrom > dateTo) throw new Error('dateFrom must not be after dateTo');
  const dates = [];
  for (let value = new Date(`${dateFrom}T00:00:00Z`), end = new Date(`${dateTo}T00:00:00Z`); value <= end; value.setUTCDate(value.getUTCDate() + 1)) {
    dates.push(value.toISOString().slice(0, 10));
  }
  if (dates.length > 120) throw new Error('Ads date range must not exceed 120 days');
  return dates;
}

export function buildOneOffReportConfig(template, dateFrom, dateTo = dateFrom) {
  if (!template?.linkedQuery || !template?.linkedAccounts?.length) {
    throw new Error('Amazon Ads CSV report template is unavailable. Create a Campaign CSV report with Campaign name and Total cost first.');
  }
  listAdsReportDates(dateFrom, dateTo);

  const report = Object.fromEntries(Object.entries(template)
    .filter(([key]) => !REPORT_STATE_KEYS.has(key)));
  return {
    ...report,
    name: `LNG Ads ${dateFrom}`,
    period: { datePeriod: { startDate: dateFrom, endDate: dateTo } },
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
