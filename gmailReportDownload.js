import { normalizeBaseUrl } from './config.js';

const AMAZON_REPORT_HOST = 'decorated-reports-prod-iad.s3.amazonaws.com';
const AMAZON_EMAIL_REDIRECT_HOST = 'na.r.ads.amazon.com';

export function classifyAmazonAdsReportLink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.hostname === AMAZON_EMAIL_REDIRECT_HOST && url.pathname.startsWith('/CL0/')) {
    return { source: 'amazon-ads-email', filename: 'amazon-ads-report.csv' };
  }
  if (url.hostname !== AMAZON_REPORT_HOST) return null;

  const filename = decodeURIComponent(url.pathname.split('/').pop() || 'amazon-ads-report.csv');
  return { source: 'amazon-ads-email', filename: filename.endsWith('.csv') ? filename : 'amazon-ads-report.csv' };
}

export function createGmailAdsDownloadFingerprint(ingestUrl, reportUrl) {
  return `${normalizeBaseUrl(ingestUrl)}\n${reportUrl}`;
}
