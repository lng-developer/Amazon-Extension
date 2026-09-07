export const EXTENSION_LOG_STORAGE_KEY = 'extensionLogs';

const SENSITIVE_KEY = /token|cookie|authorization|password|secret|header|body|email|address|phone|url/i;

function redactText(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|secret|password)=[^&\s]+)/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function redactValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value);
  if (depth >= 2) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, redactValue(item, depth + 1)]),
  );
}

const ACTIVITY_TYPES = {
  IMPORT_ADS_SPEND: 'Ads Spend',
  IMPORT_NEW_ORDERS: 'Orders',
  IMPORT_SETTLEMENTS: 'Settlements',
  IMPORT_TRANSACTIONS: 'Transactions',
};

function activityType(event) {
  const taskType = event?.context?.taskType;
  if (ACTIVITY_TYPES[taskType]) return taskType;
  const text = `${event?.message || ''} ${event?.context?.function || ''}`.toUpperCase();
  if (text.includes('ADS') || text.includes('CAMPAIGN')) return 'IMPORT_ADS_SPEND';
  if (text.includes('SETTLEMENT')) return 'IMPORT_SETTLEMENTS';
  if (text.includes('TRANSACTION')) return 'IMPORT_TRANSACTIONS';
  return 'IMPORT_NEW_ORDERS';
}

export function formatVietnamTime(timestamp) {
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp))} ICT`;
}

export function buildActivityRuns(events = []) {
  return events.reduce((runs, event) => {
    const type = activityType(event);
    const latest = [...runs].reverse().find((item) => item.type === type);
    const startsRun = /task started|requesting new orders report|acquired import_ads_spend/i.test(event.message || '');
    const withinRunWindow = latest && new Date(event.timestamp).getTime() - new Date(latest.events.at(-1).timestamp).getTime() <= 60_000;
    let run = latest && withinRunWindow && !(latest.status !== 'RUNNING' && startsRun) ? latest : null;
    if (!run) {
      run = { id: event?.context?.taskId || event?.context?.runId || `${type}-${event.timestamp}`, type, label: ACTIVITY_TYPES[type], status: 'RUNNING', startedAt: event.timestamp, error: null, events: [] };
      runs.push(run);
    }
    run.events.push(event);
    if (event.level === 'error') {
      run.status = 'FAILED';
      const error = event?.context?.errorMessage || event.message;
      if (!run.error || !/^\[ADS-LOCK\] Released error [^:]+$/.test(error)) run.error = error;
    } else if (/task completed|upload completed|hoàn thành/i.test(event.message || '')) {
      run.status = 'SUCCEEDED';
    }
    return runs;
  }, []);
}

export function createExtensionLogger({ storage, maxEntries = 200 }) {
  let writeQueue = Promise.resolve();

  const append = (level, message, context) => {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      message: redactText(message),
      ...(context ? { context: redactValue(context) } : {}),
    };
    writeQueue = writeQueue.then(async () => {
      const current = await storage.get(EXTENSION_LOG_STORAGE_KEY);
      const events = [...(current[EXTENSION_LOG_STORAGE_KEY] ?? []), event].slice(-maxEntries);
      await storage.set({ [EXTENSION_LOG_STORAGE_KEY]: events });
    });
    return writeQueue;
  };

  return {
    logInfo: (message, context) => append('info', message, context),
    logError: (_error, context, message) => append('error', message ?? 'Operation failed', context),
    logTaskProcessing: (context, message) => append('info', message || 'Task started', context),
    logTaskCompleted: (context, _result, message) => append('info', message || 'Task completed', context),
    logTaskFailed: (context, error, message) => append('error', message || error?.message || 'Task failed', { ...context, ...(error?.message ? { errorMessage: error.message } : {}) }),
    async getEvents() {
      await writeQueue;
      const current = await storage.get(EXTENSION_LOG_STORAGE_KEY);
      return current[EXTENSION_LOG_STORAGE_KEY] ?? [];
    },
    async clear() {
      await writeQueue;
      await storage.set({ [EXTENSION_LOG_STORAGE_KEY]: [] });
    },
  };
}
