import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { classifyAmazonAdsReportLink, createGmailAdsDownloadFingerprint } from '../gmailReportDownload.js';

test('accepts the Amazon Ads report redirect clicked from Gmail', () => {
  const report = classifyAmazonAdsReportLink('https://na.r.ads.amazon.com/CL0/https:%2F%2Fdecorated-reports-prod-iad.s3.amazonaws.com%2F2026%2F08%2F25%2Freport.csv');

  assert.deepEqual(report, { source: 'amazon-ads-email', filename: 'amazon-ads-report.csv' });
});

test('accepts a direct Amazon report CSV link', () => {
  const report = classifyAmazonAdsReportLink('https://decorated-reports-prod-iad.s3.amazonaws.com/2026/08/25/LNG_Daily_Campaign_Spend.csv?X-Amz-Signature=redacted');

  assert.deepEqual(report, { source: 'amazon-ads-email', filename: 'LNG_Daily_Campaign_Spend.csv' });
});

test('rejects unrelated Gmail links', () => {
  assert.equal(classifyAmazonAdsReportLink('https://example.com/report.csv'), null);
});

test('allows the Amazon Ads email redirect host before downloading the report', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.equal(manifest.host_permissions.includes('https://na.r.ads.amazon.com/*'), true);
});

test('allows the local development backend used by the Gmail report flow', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

  assert.equal(manifest.host_permissions.includes('http://localhost:3001/*'), true);
});

test('does not treat an upload to another backend as a duplicate', () => {
  const reportUrl = 'https://na.r.ads.amazon.com/CL0/https:%2F%2Fdecorated-reports-prod-iad.s3.amazonaws.com%2F2026%2F08%2F25%2Freport.csv';

  assert.notEqual(
    createGmailAdsDownloadFingerprint('https://dev-api.lngmerch.co', reportUrl),
    createGmailAdsDownloadFingerprint('http://localhost:3001', reportUrl),
  );
});
