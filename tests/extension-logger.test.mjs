import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTENSION_LOG_STORAGE_KEY, buildActivityRuns, createExtensionLogger, formatVietnamTime } from '../extensionLogger.js';

test('listing image batches have their own activity label', () => {
  const [run] = buildActivityRuns([{ timestamp: new Date().toISOString(), level: 'info', message: 'Command started', context: { taskType: 'SYNC_LISTING_IMAGES', commandId: 'images' } }]);
  assert.equal(run.label, 'Listing Images');
});

test('same transaction run stays together across a long silent gap', () => {
  const runs = buildActivityRuns([
    { timestamp: '2026-09-17T12:30:00Z', level: 'info', message: 'Transaction task started', context: { taskId: 'range-1' } },
    { timestamp: '2026-09-17T12:36:00Z', level: 'error', message: 'Transaction task failed', context: { taskId: 'range-1' } },
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'FAILED');
});

test('repeated legacy date ranges are distinct attempts even when the first has no ending', () => {
  const runs = buildActivityRuns([
    { timestamp: '2026-09-17T12:30:00Z', level: 'info', message: 'Transaction task started', context: { taskId: 'same-range' } },
    { timestamp: '2026-09-17T12:30:20Z', level: 'info', message: 'Transaction task started', context: { taskId: 'same-range' } },
    { timestamp: '2026-09-17T12:30:30Z', level: 'info', message: 'Transaction task completed', context: { taskId: 'same-range' } },
  ], { now: Date.parse('2026-09-17T13:00:00Z') });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(r => r.status), ['UNKNOWN', 'SUCCEEDED']);
  assert.notEqual(runs[0].id, runs[1].id);
});

test('explicit lifecycle status handles Orders completion and custom wording', async () => {
  const logger = createExtensionLogger({ storage: createStorage() });
  const context = { commandId: 'order-1', taskType: 'IMPORT_NEW_ORDERS' };
  await logger.logTaskProcessing(context, 'Sending orders');
  await logger.logTaskCompleted(context, {}, 'Report accepted');
  const runs = buildActivityRuns(await logger.getEvents());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'SUCCEEDED');
});

test('backend command status wins over local success and expired running is unknown', () => {
  const events = [{ timestamp: '2026-09-17T12:30:00Z', level: 'info', message: 'Transaction task completed', context: { commandId: 'cmd-1', taskType: 'IMPORT_TRANSACTIONS' } }];
  const [failed] = buildActivityRuns(events, { commands: [{ id: 'cmd-1', status: 'FAILED', errorMessage: 'Extension lease expired' }] });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error, 'Extension lease expired');
  const [expired] = buildActivityRuns(events, { now: Date.parse('2026-09-17T13:00:00Z'), commands: [{ id: 'cmd-1', status: 'RUNNING', leaseExpiresAt: '2026-09-17T12:35:00Z' }] });
  assert.equal(expired.status, 'UNKNOWN');
});

test('late completion of one command cannot complete another active command', () => {
  const events = [
    { timestamp: '2026-09-17T12:30:00Z', level: 'info', message: 'Command task started', context: { commandId: 'first', taskType: 'IMPORT_NEW_ORDERS' } },
    { timestamp: '2026-09-17T12:31:00Z', level: 'info', message: 'Command task started', context: { commandId: 'second', taskType: 'IMPORT_NEW_ORDERS' } },
    { timestamp: '2026-09-17T12:32:00Z', level: 'info', message: 'Command task completed', context: { commandId: 'first', taskType: 'IMPORT_NEW_ORDERS' } },
  ];
  const runs = buildActivityRuns(events, { now: Date.parse('2026-09-17T12:32:00Z') });
  assert.deepEqual(runs.map(r => [r.commandId, r.status]), [['first', 'SUCCEEDED'], ['second', 'RUNNING']]);
});

test('a cached running snapshot cannot override completion already acknowledged by the backend', () => {
  const [run] = buildActivityRuns([
    { timestamp: '2026-09-17T12:31:00Z', level: 'info', message: 'Command task completed',
      context: { commandId: 'cmd', taskType: 'IMPORT_NEW_ORDERS', activityStatus: 'SUCCEEDED', backendConfirmed: true } },
  ], { now: Date.parse('2026-09-17T12:40:00Z'), commands: [{ id: 'cmd', status: 'RUNNING', leaseExpiresAt: '2026-09-17T12:35:00Z' }] });
  assert.equal(run.status, 'SUCCEEDED');
});

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
