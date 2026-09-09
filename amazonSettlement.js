export const SETTLEMENT_IMPORT_COOLDOWN_MS = 10 * 60 * 1000;

function toIsoDate(month, day, year) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseStatementPeriod(value = '') {
  const matches = [...String(value).matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  if (matches.length < 2) return null;
  return {
    dateFrom: toIsoDate(matches[0][1], matches[0][2], matches[0][3]),
    dateTo: toIsoDate(matches[1][1], matches[1][2], matches[1][3]),
  };
}

export function selectSettlementDownload(candidates = [], { dateFrom, dateTo } = {}) {
  const matches = candidates.filter((candidate) => {
    const period = candidate?.period || parseStatementPeriod(candidate?.periodText || candidate?.text || '');
    return candidate?.href
      && candidate.isFlatFileV2 === true
      && period?.dateFrom === dateFrom
      && period?.dateTo === dateTo;
  });

  if (!matches.length) {
    throw new Error(`Settlement period ${dateFrom} to ${dateTo} not found or has no Flat File V2 link`);
  }
  if (matches.length > 1) {
    throw new Error(`Settlement period ${dateFrom} to ${dateTo} is ambiguous`);
  }
  return matches[0];
}

export function validateSettlementText(text = '') {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0]?.split('\t') || [];
  const requiredColumns = [
    'settlement-id',
    'settlement-start-date',
    'settlement-end-date',
    'deposit-date',
    'total-amount',
    'currency',
    'transaction-type',
    'amount-type',
    'amount',
  ];
  if (!lines.length || requiredColumns.some((column) => !header.includes(column)) || lines.length < 2) {
    throw new Error('Invalid settlement file: expected Amazon Flat File V2 columns');
  }
  return { header, rowCount: lines.length - 1 };
}

export function canStartSettlementImport(previous, now = Date.now()) {
  if (!previous?.attemptedAt) return true;
  return now - Number(previous.attemptedAt) >= SETTLEMENT_IMPORT_COOLDOWN_MS;
}

export function settlementImportDecision({ completed, referenceId }) {
  return completed
    ? { ok: true, skipped: true, reason: 'SETTLEMENT_ALREADY_IMPORTED', referenceId }
    : null;
}

export function getSettlementReferenceId(href) {
  const referenceId = new URL(href).searchParams.get('referenceId');
  if (!referenceId) throw new Error('Settlement download link has no referenceId');
  return referenceId;
}
