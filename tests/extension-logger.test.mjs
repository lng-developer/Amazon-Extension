import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTENSION_LOG_STORAGE_KEY, buildActivityRuns, createExtensionLogger, formatVietnamTime } from '../extensionLogger.js';

function createStorage() {
  const values = {};
  return {
    async get(key) {
      return { [key]: values[key] ?? [] };
    },
    async set(next) {
      Object.assign(values, next);
    },
    values,
  };
}

test('extension logger redacts sensitive context before local persistence', async () => {
  const storage = createStorage();
  const logger = createExtensionLogger({ storage });

  await logger.logInfo('Authorization: Bearer secret-token', {
    token: 'secret-token',
    cookie: 'session=value',
    requestBody: { buyerEmail: 'buyer@example.com' },
    taskType: 'IMPORT_NEW_ORDERS',
  });

  const [event] = storage.values[EXTENSION_LOG_STORAGE_KEY];
  assert.equal(event.message.includes('secret-token'), false);
  assert.deepEqual(event.context, { taskType: 'IMPORT_NEW_ORDERS' });
});

test('extension logger retains only the configured newest events', async () => {
  const storage = createStorage();
  const logger = createExtensionLogger({ storage, maxEntries: 2 });

  await logger.logInfo('first');
  await logger.logInfo('second');
  await logger.logInfo('third');

  assert.deepEqual(
    storage.values[EXTENSION_LOG_STORAGE_KEY].map((event) => event.message),
    ['second', 'third'],
  );
});

test('extension logger does not persist arbitrary error response text', async () => {
  const storage = createStorage();
  const logger = createExtensionLogger({ storage });

  await logger.logError(new Error('Amazon response contained buyer@example.com'), { status: 500 });

  assert.equal(storage.values[EXTENSION_LOG_STORAGE_KEY][0].message, 'Operation failed');
});

test('activity timeline groups a failed Ads run and formats the operator time in ICT', () => {
  const runs = buildActivityRuns([
    {
      timestamp: '2026-08-23T06:16:15.818Z',
      level: 'info',
      message: 'Task started',
      context: { taskId: 'ads-1', taskType: 'IMPORT_ADS_SPEND' },
    },
    {
      timestamp: '2026-08-23T06:16:23.908Z',
      level: 'error',
      message: 'Amazon Ads headers are unavailable. Sign in to advertising.amazon.com and open the campaign page.',
    },
    {
      timestamp: '2026-08-23T06:16:23.909Z',
      level: 'error',
      message: '[ADS-LOCK] Released error IMPORT_ADS_SPEND',
    },
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].type, 'IMPORT_ADS_SPEND');
  assert.equal(runs[0].status, 'FAILED');
  assert.match(runs[0].error, /Sign in to advertising/);
  assert.equal(runs[0].events.length, 3);
  assert.match(formatVietnamTime(runs[0].startedAt), /13:16:15 ICT/);
});

test('activity timeline marks a completed Gmail Ads upload as succeeded', () => {
  const runs = buildActivityRuns([
    {
      timestamp: '2026-08-25T08:40:00.000Z',
      level: 'info',
      message: 'Downloading Amazon Ads report from Gmail',
      context: { taskId: 'gmail-ads-1', taskType: 'IMPORT_ADS_SPEND' },
    },
    {
      timestamp: '2026-08-25T08:40:02.000Z',
      level: 'info',
      message: 'Amazon Ads report upload completed',
      context: { taskId: 'gmail-ads-1', taskType: 'IMPORT_ADS_SPEND' },
    },
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'SUCCEEDED');
});

test('activity timeline marks a completed transaction import as succeeded', () => {
  const runs = buildActivityRuns([
    { timestamp: '2026-09-07T11:43:01.491Z', level: 'info', message: 'Transaction task started', context: { taskId: 'transactions-1' } },
    { timestamp: '2026-09-07T11:43:30.206Z', level: 'info', message: 'Transaction task completed', context: { taskId: 'transactions-1' } },
  ]);

  assert.equal(runs[0].status, 'SUCCEEDED');
});
