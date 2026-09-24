/* ===============================
   background.js (MV3, ESM) — APO LNG (Realtime only)
   - Không ghi DB: không /api/ext/connect, không /api/logs/*
   - Chỉ Socket.IO realtime: ext:heartbeat, ext:log, client:ack
   - Import NEW / Report ALL / Ads vẫn hoạt động như cũ
   - Auto: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 (giờ LOCAL)
   =============================== */

import { io } from "./lib/socket.io.esm.min.js";
import {
  buildSafeUploadFeedCsrfDiagnostic,
  canSubmitAmazonRow,
  getReadOnlyUploadFeedWarmupSelectors,
  getNativeUploadFormSelectors,
  selectReadOnlyUploadFeedCsrfCapture,
  shouldCloseDedicatedUploadFeedTab,
  shouldNavigateSellerCentralFeedsTab,
  summarizeNativeUploadForm,
} from "./lib/upload-feed-task-tab-policy.js";
import { shouldCloseAutoCreatedAdsTab } from "./lib/ads-task-tab-policy.js";
import { shouldReconnectSocket } from "./lib/socket-reconnect-policy.js";
import {
  buildAmazonFeedDoneEvent,
  findNewAmazonFeedRow,
  nextAmazonFeedWatchState,
  shouldRefreshAmazonFeedHistory,
} from "./lib/amazon-feed-history.js";

const ADS_LOCK_STALE_MS = 5 * 60 * 1000;
const adsApiLock = {
  running: false,
  taskName: "",
  runId: "",
  startedAt: 0,
};
const UPLOAD_TRACKING_LOCK_STALE_MS = 10 * 60 * 1000;
const uploadTrackingLock = {
  running: false,
  taskName: "",
  runId: "",
  startedAt: 0,
};
let importOrdersInProgress = false;
const SOCKET_RECONNECT_ALARM = "SOCKET_RECONNECT";
const SOCKET_RECONNECT_PERIOD_MINUTES = 1;
const AMAZON_FEED_WATCH_ALARM = "AMAZON_FEED_WATCH";
const AMAZON_FEED_WATCH_PERIOD_MINUTES = 0.5;
const AMAZON_FEED_WATCHES_KEY = "amazonFeedWatches";

// Global logger instance
let extensionLogger = null;

// Initialize logger when we have identity
async function initializeLogger() {
  if (!extensionLogger) {
    try {
      const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();
      if (base && shopId && clientId) {
        extensionLogger = new ExtensionLogger(clientId, shopId, clientLabel || 'Unknown Shop', base);
        console.log('[LOGGER] Extension logger initialized', { clientId, shopId, clientLabel, base });
      }
    } catch (error) {
      console.error('[LOGGER] Failed to initialize extension logger:', error);
    }
  }
  return extensionLogger;
}

/* ========== Extension Logger Class ========== */
class ExtensionLogger {
  constructor(machineId, shopId, shopName, apiBaseUrl) {
    this.machineId = machineId;
    this.shopId = shopId;
    this.shopName = shopName;
    this.apiBaseUrl = apiBaseUrl;
    this.sessionId = this.generateSessionId();
    this.extensionVersion = chrome.runtime.getManifest().version;
    this.debugMode = true; // Enable console logging
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async submitLog(logType, message, options = {}) {
    try {
      // Vòng đời task đã hiển thị trên UI; chỉ lưu lỗi để tránh Log Manager thành stream debug.
      if (options.level !== 'error') return;

      const logData = {
        machineId: this.machineId,
        shopId: this.shopId,
        shopName: this.shopName,
        logType,
        message,
        level: options.level || 'info',
        taskInfo: options.taskInfo,
        uploadInfo: options.uploadInfo,
        errorInfo: options.errorInfo,
        metadata: {
          extensionVersion: this.extensionVersion,
          browserInfo: navigator.userAgent,
          sessionId: this.sessionId,
          requestId: options.requestId,
          ...options.metadata
        },
        performance: options.performance,
        rawData: options.rawData
      };

      if (this.debugMode) {
        console.log(`[EXT-LOG] ${logType.toUpperCase()}: ${message}`, logData);
      }

      if (!this.apiBaseUrl) {
        console.warn('[EXT-LOG] No API base URL configured, skipping server log');
        return;
      }

      const response = await fetch(`${this.apiBaseUrl}/api/ext/logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(logData)
      });

      const result = await response.json();

      if (!result.success && this.debugMode) {
        console.error('[EXT-LOG] Failed to submit log:', result);
      }

      return result;
    } catch (error) {
      if (this.debugMode) {
        console.error('[EXT-LOG] Error submitting log:', error);
      }
      // Không throw error để tránh ảnh hưởng đến logic chính
    }
  }

  // Convenience methods
  async logTaskReceived(taskInfo, message = 'Task received from server') {
    return this.submitLog('task_received', message, { taskInfo });
  }

  async logTaskProcessing(taskInfo, message = 'Processing task') {
    return this.submitLog('task_processing', message, { taskInfo });
  }

  async logTaskCompleted(taskInfo, performance, message = 'Task completed successfully') {
    return this.submitLog('task_completed', message, { taskInfo, performance });
  }

  async logTaskFailed(taskInfo, error, message = 'Task failed') {
    return this.submitLog('task_failed', message, {
      taskInfo,
      level: 'error',
      errorInfo: {
        errorCode: error.code || 'UNKNOWN_ERROR',
        errorMessage: error.message,
        stackTrace: error.stack
      }
    });
  }

  async logConnectionStatus(status, details = {}, message) {
    return this.submitLog('connection_status', message, {
      level: ['failed', 'disconnected', 'reconnect_failed', 'status_check_error', 'config_check_failed'].includes(status)
        ? 'error'
        : 'info',
      rawData: { status, ...details }
    });
  }

  async logUploadStarted(uploadInfo, taskInfo, message = 'Upload started') {
    return this.submitLog('upload_started', message, { uploadInfo, taskInfo });
  }

  async logUploadCompleted(uploadInfo, taskInfo, performance, message = 'Upload completed successfully') {
    return this.submitLog('upload_completed', message, { uploadInfo, taskInfo, performance });
  }

  async logUploadFailed(uploadInfo, taskInfo, error, message = 'Upload failed') {
    return this.submitLog('upload_failed', message, {
      uploadInfo,
      taskInfo,
      level: 'error',
      errorInfo: {
        errorCode: error.code || 'UPLOAD_ERROR',
        errorMessage: error.message,
        stackTrace: error.stack
      }
    });
  }

  async logUploadProgress(uploadInfo, message = 'Upload progress update') {
    return this.submitLog('upload_progress', message, { uploadInfo });
  }

  async logError(error, context = {}, message = 'Error occurred') {
    return this.submitLog('error', message, {
      level: 'error',
      errorInfo: {
        errorCode: error.code || 'GENERAL_ERROR',
        errorMessage: error.message,
        stackTrace: error.stack,
        context
      }
    });
  }

  async logInfo(message, rawData = {}) {
    return this.submitLog('info', message, { rawData });
  }

  async logDebug(message, rawData = {}) {
    return this.submitLog('debug', message, { level: 'debug', rawData });
  }
}

/* ========== Original Code ========== */

const RUNTIME_LOG_STORAGE_KEY = "runtimeLogEntries";
const RUNTIME_LOG_LIMIT = 50;
let runtimeLogWrite = Promise.resolve();

function persistRuntimeLog(message, level = "info") {
  const normalizedMessage = String(message || "").replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, "");
  const entry = { message: normalizedMessage, level, time: new Date().toLocaleTimeString(), at: Date.now(), count: 1 };
  runtimeLogWrite = runtimeLogWrite
    .then(async () => {
      const stored = await chrome.storage.local.get([RUNTIME_LOG_STORAGE_KEY]);
      const entries = Array.isArray(stored[RUNTIME_LOG_STORAGE_KEY]) ? stored[RUNTIME_LOG_STORAGE_KEY] : [];
      const last = entries.at(-1);
      if (last && last.message === entry.message && entry.at - Number(last.at || 0) < 10_000) last.count = Number(last.count || 1) + 1;
      else entries.push(entry);
      await chrome.storage.local.set({ [RUNTIME_LOG_STORAGE_KEY]: entries.slice(-RUNTIME_LOG_LIMIT) });
    })
    .catch((error) => console.warn("[RUNTIME-LOG] persist failed:", error?.message || error));
}

const log = (...args) => {
  const message = `[${new Date().toLocaleTimeString()}] ` + args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log("[APO]", ...args);  // Giữ console.log cho debug
  persistRuntimeLog(message);
  // Gửi đến popup để hiển thị trên màn hình
  chrome.runtime.sendMessage({ type: "LOG", payload: message }).catch(() => { });  // Ignore lỗi nếu popup không mở
};

const SC_BASE = "https://sellercentral.amazon.com";
const SC_FEEDS_URL = `${SC_BASE}/order-reports-and-feeds/feeds`;
const AMAZON_UPLOADFEED_URL_PATH = "/order-reports-and-feeds/api/uploadFeed";
const AMAZON_UPLOADFEED_PAGE_URL = "https://sellercentral.amazon.com/order-reports-and-feeds/feeds";
const AMAZON_UPLOADFEED_MIN_CSRF_LENGTH = 80;
const AMAZON_UPLOADFEED_BUILD_ID = "uploadfeed-page-context-csrf-formdata-v1";
const AMAZON_UPLOADFEED_CSRF_CACHE_KEY = "amazonUploadFeedCsrfCache";
const AMAZON_UPLOADFEED_CSRF_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const AMAZON_UPLOADFEED_SNIFFER_FLAG = "__APO_UPLOADFEED_SNIFFER_INSTALLED__";
globalThis.__UPLOADFEED_HELPER_BUILD__ = "uploadfeed-helper-v2026-05-12-01";
console.log("[UPLOAD_TRACKING] HELPER BUILD LOADED", globalThis.__UPLOADFEED_HELPER_BUILD__);
const ADS_BASE = "https://advertising.amazon.com";
const ADS_CAMPAIGNS_URL = `${ADS_BASE}/campaign-manager/all-campaigns`;
const ADS_RETRIEVE_URL =
  "https://advertising.amazon.com/a9g-api-gateway/cm/dds/retrieveReport";

/* ---------- Amazon Ads Auth Hardening ---------- */
const ADS_HEADER_STORAGE_KEYS = [
  "adsAccountId",
  "adsAdvertiserId",
  "adsClientId",
  "adsMarketplaceId",
  "adsCsrfData",
  "adsCsrfToken",
  "adsHeaderLastSeen",
];
const ADS_HEADER_REFRESH_TIMEOUT_MS = 25 * 1000;
const ADS_TAB_LOAD_TIMEOUT_MS = 35 * 1000;
const ADS_PAGE_SETTLE_MS = 3500;
const ADS_LAST_RESULT_STORAGE_KEY = "adsLastResult";

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAdsHeaderComplete(st = {}) {
  return !!(
    st.adsAccountId &&
    st.adsAdvertiserId &&
    st.adsClientId &&
    st.adsMarketplaceId &&
    st.adsCsrfData &&
    st.adsCsrfToken
  );
}

async function readAdsHeaderState() {
  return chrome.storage.local.get(ADS_HEADER_STORAGE_KEYS);
}

function makeAdsRunId(taskName) {
  return `${taskName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isAdsApiLocked() {
  if (!adsApiLock.running) return false;
  const age = Date.now() - Number(adsApiLock.startedAt || 0);
  if (age > ADS_LOCK_STALE_MS) {
    debugLog(`[ADS-LOCK] Stale lock expired ${adsApiLock.taskName} runId=${adsApiLock.runId}`, "error");
    adsApiLock.running = false;
    adsApiLock.taskName = "";
    adsApiLock.runId = "";
    adsApiLock.startedAt = 0;
    chrome.storage.local.set({ adsApiLockState: { ...adsApiLock } }).catch(() => { });
    return false;
  }
  return true;
}

function isAdsLockOwner(runId) {
  return !!runId && isAdsApiLocked() && adsApiLock.runId === runId;
}

async function persistAdsLockState() {
  await chrome.storage.local.set({ adsApiLockState: { ...adsApiLock } });
}

function createAdsLockSkipped(taskName) {
  return {
    ok: false,
    skipped: true,
    reason: "ADS_TASK_ALREADY_RUNNING",
    runningTaskName: adsApiLock.taskName,
    runningRunId: adsApiLock.runId,
  };
}

async function withAdsApiLock(taskName, fn, options = {}) {
  if (isAdsApiLocked()) {
    const message = `[ADS-LOCK] Skip ${taskName}, another Ads task is running: ${adsApiLock.taskName}`;
    debugLog(message, "info");
    log(message);
    extensionLogger?.logInfo(message, {
      requestedTaskName: taskName,
      runningTaskName: adsApiLock.taskName,
      runningRunId: adsApiLock.runId,
      runningStartedAt: adsApiLock.startedAt,
    });
    if (options.throwOnSkip) {
      const err = new Error(message);
      err.code = "ADS_TASK_ALREADY_RUNNING";
      throw err;
    }
    return createAdsLockSkipped(taskName);
  }

  const runId = options.runId || makeAdsRunId(taskName);
  adsApiLock.running = true;
  adsApiLock.taskName = taskName;
  adsApiLock.runId = runId;
  adsApiLock.startedAt = Date.now();
  await persistAdsLockState();

  debugLog(`[ADS-LOCK] Acquired ${taskName} runId=${runId}`, "success");
  log(`[ADS-LOCK] Acquired ${taskName} runId=${runId}`);
  extensionLogger?.logInfo(`[ADS-LOCK] Acquired ${taskName}`, { runId, taskName, startedAt: adsApiLock.startedAt });

  try {
    const result = await fn({ runId, taskName, lockOwner: true });
    debugLog(`[ADS-LOCK] Released success ${taskName} runId=${runId}`, "success");
    extensionLogger?.logInfo(`[ADS-LOCK] Released success ${taskName}`, { runId, taskName });
    return result;
  } catch (error) {
    debugLog(`[ADS-LOCK] Released error ${taskName} runId=${runId}: ${error?.message || error}`, "error");
    extensionLogger?.logError(error, { runId, taskName }, `[ADS-LOCK] Released error ${taskName}`);
    throw error;
  } finally {
    if (adsApiLock.runId === runId) {
      adsApiLock.running = false;
      adsApiLock.taskName = "";
      adsApiLock.runId = "";
      adsApiLock.startedAt = 0;
      await persistAdsLockState();
    }
  }
}

function makeUploadTrackingRunId(taskName) {
  return `${taskName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isUploadTrackingLocked() {
  if (!uploadTrackingLock.running) return false;
  const age = Date.now() - Number(uploadTrackingLock.startedAt || 0);
  if (age > UPLOAD_TRACKING_LOCK_STALE_MS) {
    const message = `[UPLOAD_TRACKING_LOCK] Stale lock expired ${uploadTrackingLock.taskName} runId=${uploadTrackingLock.runId}`;
    debugLog(message, "error");
    extensionLogger?.logInfo(message, { lock: { ...uploadTrackingLock }, age });
    uploadTrackingLock.running = false;
    uploadTrackingLock.taskName = "";
    uploadTrackingLock.runId = "";
    uploadTrackingLock.startedAt = 0;
    chrome.storage.local.set({ uploadTrackingLockState: { ...uploadTrackingLock } }).catch(() => { });
    return false;
  }
  return true;
}

async function persistUploadTrackingLockState() {
  await chrome.storage.local.set({ uploadTrackingLockState: { ...uploadTrackingLock } });
}

function createUploadTrackingLockSkipped(taskName) {
  return {
    ok: false,
    skipped: true,
    reason: "UPLOAD_TRACKING_ALREADY_RUNNING",
    runningTaskName: uploadTrackingLock.taskName,
    runningRunId: uploadTrackingLock.runId,
    requestedTaskName: taskName,
  };
}

async function withUploadTrackingLock(taskName, fn, options = {}) {
  if (isUploadTrackingLocked()) {
    const skipped = createUploadTrackingLockSkipped(taskName);
    const message = `[UPLOAD_TRACKING_LOCK] Skip ${taskName}, another upload is running: ${uploadTrackingLock.taskName}`;
    debugLog(message, "info");
    extensionLogger?.logInfo(message, {
      requestedTaskName: taskName,
      runningTaskName: uploadTrackingLock.taskName,
      runningRunId: uploadTrackingLock.runId,
      runningStartedAt: uploadTrackingLock.startedAt,
    });
    if (options.throwOnSkip) {
      const err = new Error(message);
      Object.assign(err, skipped);
      throw err;
    }
    return skipped;
  }

  const runId = options.runId || makeUploadTrackingRunId(taskName);
  uploadTrackingLock.running = true;
  uploadTrackingLock.taskName = taskName;
  uploadTrackingLock.runId = runId;
  uploadTrackingLock.startedAt = Date.now();
  await persistUploadTrackingLockState();

  debugLog(`[UPLOAD_TRACKING_LOCK] Acquired ${taskName} runId=${runId}`, "success");
  extensionLogger?.logInfo(`[UPLOAD_TRACKING_LOCK] Acquired ${taskName}`, {
    runId,
    taskName,
    startedAt: uploadTrackingLock.startedAt,
  });

  try {
    const result = await fn({ runId, taskName, lockOwner: true });
    debugLog(`[UPLOAD_TRACKING_LOCK] Released success ${taskName} runId=${runId}`, "success");
    extensionLogger?.logInfo(`[UPLOAD_TRACKING_LOCK] Released success ${taskName}`, { runId, taskName });
    return result;
  } catch (error) {
    debugLog(`[UPLOAD_TRACKING_LOCK] Released error ${taskName} runId=${runId}: ${error?.message || error}`, "error");
    extensionLogger?.logError(error, { runId, taskName }, `[UPLOAD_TRACKING_LOCK] Released error ${taskName}`);
    throw error;
  } finally {
    if (uploadTrackingLock.runId === runId) {
      uploadTrackingLock.running = false;
      uploadTrackingLock.taskName = "";
      uploadTrackingLock.runId = "";
      uploadTrackingLock.startedAt = 0;
      await persistUploadTrackingLockState();
    }
  }
}

async function runUploadTrackingWithLock(context = {}) {
  return withUploadTrackingLock("UPLOAD_TRACKING", async (lock) => {
    return uploadtracking({ ...context, lock });
  });
}

function canMutateAdsHeaders(options = {}) {
  if (!isAdsApiLocked()) return true;
  return !!options.lockOwner && isAdsLockOwner(options.runId);
}

async function clearAdsHeaders(reason = "unknown", options = {}) {
  if (!canMutateAdsHeaders(options)) {
    debugLog("[ADS-AUTH] clear blocked: not lock owner", "error");
    extensionLogger?.logInfo("[ADS-AUTH] clear blocked: not lock owner", {
      reason,
      callerRunId: options.runId,
      callerTaskName: options.taskName,
      lock: { ...adsApiLock },
    });
    return false;
  }

  await chrome.storage.local.remove([...ADS_HEADER_STORAGE_KEYS, "adsCandidateHeaders"]);
  debugLog(`🧹 [ADS-AUTH] Cleared cached Ads headers: ${reason}`, "info");
  extensionLogger?.logInfo("[ADS-AUTH] Cleared cached Ads headers", { reason, runId: options.runId, taskName: options.taskName });
  return true;
}

function isAdsSignInText(text = "") {
  return /sign[\s-]?in|password|passkey|authentication|login|unauthorized|csrf/i.test(String(text || ""));
}

function createAdsError(message, status = 0, responseText = "") {
  const err = new Error(message);
  err.status = status;
  err.responseText = responseText;
  err.code = status === 401 || status === 403 || isAdsSignInText(responseText)
    ? "ADS_AUTH_ERROR"
    : "ADS_API_ERROR";
  return err;
}

function isAdsAuthError(error) {
  const status = Number(error?.status || 0);
  return (
    status === 401 ||
    status === 403 ||
    error?.code === "ADS_AUTH_ERROR" ||
    isAdsSignInText(error?.responseText || error?.message || "")
  );
}

async function waitForAdsTabComplete(tabId, timeoutMs = ADS_TAB_LOAD_TIMEOUT_MS) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (existing?.status === "complete") return true;

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onUpdated = (tid, info) => {
      if (tid === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function getAdsPageHint(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        href: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || "").slice(0, 1200),
      }),
    });
    return res?.result || {};
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

async function waitForAdsHeaderCapture({ since = 0, timeoutMs = ADS_HEADER_REFRESH_TIMEOUT_MS } = {}) {
  const initial = await readAdsHeaderState();
  if (isAdsHeaderComplete(initial) && (!since || Number(initial.adsHeaderLastSeen || 0) >= since - 1000)) {
    return true;
  }
  const initialCandidate = await chrome.storage.local.get(["adsCandidateHeaders"]);
  if (isAdsHeaderComplete(initialCandidate.adsCandidateHeaders || {}) &&
    (!since || Number(initialCandidate.adsCandidateHeaders.adsHeaderLastSeen || 0) >= since - 1000)) {
    return true;
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(listener);
      if (!ok) {
        const latest = await readAdsHeaderState();
        ok = isAdsHeaderComplete(latest) && (!since || Number(latest.adsHeaderLastSeen || 0) >= since - 1000);
        if (!ok) {
          const candidate = await chrome.storage.local.get(["adsCandidateHeaders"]);
          ok = isAdsHeaderComplete(candidate.adsCandidateHeaders || {}) &&
            (!since || Number(candidate.adsCandidateHeaders.adsHeaderLastSeen || 0) >= since - 1000);
        }
      }
      resolve(!!ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    const watched = new Set([...ADS_HEADER_STORAGE_KEYS, "adsCandidateHeaders"]);
    const listener = async (changes, areaName) => {
      if (areaName !== "local") return;
      if (!Object.keys(changes || {}).some((k) => watched.has(k))) return;
      const latest = await readAdsHeaderState();
      const candidate = await chrome.storage.local.get(["adsCandidateHeaders"]);
      const candidateOk = isAdsHeaderComplete(candidate.adsCandidateHeaders || {}) &&
        (!since || Number(candidate.adsCandidateHeaders.adsHeaderLastSeen || 0) >= since - 1000);
      if ((isAdsHeaderComplete(latest) && (!since || Number(latest.adsHeaderLastSeen || 0) >= since - 1000)) || candidateOk) {
        finish(true);
      }
    };
    chrome.storage.onChanged.addListener(listener);
  });
}


/* ---------- Cookies & CSRF (Seller Central) ---------- */
async function getCookie(url, name) {
  try {
    const ck = await chrome.cookies.get({ url, name });
    return ck?.value || "";
  } catch {
    return "";
  }
}

function createAmazonUploadError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function logUploadTrackingDiagnostic(message, fields = {}, level = "info") {
  const safeFields = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const lowerKey = String(key).toLowerCase();
    if (lowerKey.includes("csrf") && typeof value === "string" && !lowerKey.includes("included") && !lowerKey.includes("source") && !lowerKey.includes("length")) {
      safeFields[key] = value ? "[redacted]" : value;
    } else if (lowerKey.includes("cookie") && typeof value === "string") {
      safeFields[key] = value ? "[redacted]" : value;
    } else {
      safeFields[key] = value;
    }
  }

  const inlineFields = Object.entries(safeFields)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" ");
  const fullMessage = inlineFields ? `${message} ${inlineFields}` : message;
  debugLog(fullMessage, level);
  extensionLogger?.logInfo(fullMessage, safeFields);
}

function isValidUploadFeedCsrfToken(value) {
  const token = String(value || "").trim();
  if (!token) return false;
  if (token.length < AMAZON_UPLOADFEED_MIN_CSRF_LENGTH) return false;
  if (/^(undefined|null|true|false)$/i.test(token)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(token);
}

const uploadFeedCaptureLogDedupe = { lastKey: "", lastAt: 0 };

function shouldLogUploadFeedCapture(source, tokenLength) {
  const key = `${source}:${tokenLength}`;
  const now = Date.now();
  if (uploadFeedCaptureLogDedupe.lastKey === key && now - uploadFeedCaptureLogDedupe.lastAt < 5000) return false;
  uploadFeedCaptureLogDedupe.lastKey = key;
  uploadFeedCaptureLogDedupe.lastAt = now;
  return true;
}

async function getUploadFeedCsrfCacheStatus() {
  const data = await chrome.storage.local.get([AMAZON_UPLOADFEED_CSRF_CACHE_KEY]);
  const cache = data[AMAZON_UPLOADFEED_CSRF_CACHE_KEY] || null;
  const token = String(cache?.token || "");
  const ageMs = cache?.capturedAt ? Date.now() - Number(cache.capturedAt || 0) : null;
  const expired = ageMs !== null && ageMs > AMAZON_UPLOADFEED_CSRF_CACHE_TTL_MS;
  const tokenValid = isValidUploadFeedCsrfToken(token);
  const isTestToken = !!cache?.isTestToken;
  const valid = !!cache?.token && tokenValid && !expired && !isTestToken;
  return {
    cache,
    valid,
    tokenFound: !!cache?.token,
    tokenLength: cache?.tokenLength || token.length || 0,
    source: cache?.source || null,
    ageMs,
    ageMin: ageMs === null ? null : Math.floor(ageMs / 60000),
    expired,
    tokenValid,
    isTestToken,
  };
}

async function getCachedUploadFeedCsrfToken() {
  const status = await getUploadFeedCsrfCacheStatus();
  return status.valid ? status.cache : null;
}

async function clearUploadFeedCsrfCache(reason = "unknown", metadata = {}) {
  await chrome.storage.local.remove([AMAZON_UPLOADFEED_CSRF_CACHE_KEY]);
  logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed csrf cache cleared", {
    reason,
    code: metadata?.code || "",
    status: metadata?.status || 0,
  }, "info");
  return { ok: true, cleared: true, reason };
}

async function saveUploadFeedCsrfTokenCapture(capture = {}) {
  const token = String(capture.token || "").trim();
  if (!isValidUploadFeedCsrfToken(token)) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed csrfToken capture ignored", {
      source: capture.source || "unknown",
      tokenLength: token.length,
      valid: false,
      url: capture.url || "",
      pageTitle: capture.pageTitle || "",
    }, "error");
    return { ok: false, reason: "invalid_token" };
  }

  const cache = {
    token,
    tokenLength: token.length,
    source: ["formDataAppend", "formDataSet", "fetchFormData", "requestFormData", "xhrFormData", "consoleLog", "webRequestFormData", "readOnlyCookie", "readOnlyStorage", "readOnlyPage"].includes(capture.source) ? capture.source : "formDataAppend",
    capturedAt: Number(capture.capturedAt || Date.now()),
    url: String(capture.url || ""),
    pageTitle: String(capture.pageTitle || ""),
    isTestToken: !!capture.isTestToken,
  };
  await chrome.storage.local.set({ [AMAZON_UPLOADFEED_CSRF_CACHE_KEY]: cache });
  if (shouldLogUploadFeedCapture(cache.source, cache.tokenLength)) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed csrfToken captured", {
      source: cache.source,
      tokenLength: cache.tokenLength,
      capturedAt: cache.capturedAt,
      url: cache.url,
      pageTitle: cache.pageTitle,
      isTestToken: cache.isTestToken,
    }, cache.source === "webRequestFormData" ? "success" : "info");
  }
  return { ok: true, tokenLength: cache.tokenLength, source: cache.source, capturedAt: cache.capturedAt };
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const formData = details?.requestBody?.formData || {};
      const rawToken = Array.isArray(formData.csrfToken) ? formData.csrfToken[0] : formData.csrfToken;
      const token = String(rawToken || "").trim();
      const fieldNames = Object.keys(formData);
      if (!isValidUploadFeedCsrfToken(token)) return;

      if (shouldLogUploadFeedCapture("webRequestFormData", token.length)) {
        logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed csrfToken captured by webRequest", {
          source: "webRequestFormData",
          tokenLength: token.length,
          fieldNames,
          url: details.url || "",
        }, "success");
      }

      Promise.resolve(saveUploadFeedCsrfTokenCapture({
        token,
        source: "webRequestFormData",
        url: details.url,
        pageTitle: "Captured by webRequest",
        capturedAt: Date.now(),
        isTestToken: false
      })).catch((error) => {
        console.warn("[UPLOAD_TRACKING] webRequest csrfToken capture failed:", error?.message || error);
      });
    } catch (error) {
      console.warn("[UPLOAD_TRACKING] webRequest uploadFeed capture exception:", error?.message || error);
    }
  },
  { urls: [`${SC_BASE}${AMAZON_UPLOADFEED_URL_PATH}*`] },
  ["requestBody"]
);

function extractUploadFeedCsrfTokenInPage() {
  const MIN_CSRF_LENGTH = 80;
  const isValid = (value) => {
    const token = String(value || "").trim();
    if (!token) return false;
    if (token.length < MIN_CSRF_LENGTH) return false;
    if (/^(undefined|null|true|false)$/i.test(token)) return false;
    return /^[A-Za-z0-9+/=_-]+$/.test(token);
  };
  const candidates = [];
  const addCandidate = (value, source) => {
    const token = String(value || "").trim();
    if (isValid(token)) candidates.push({ csrfToken: token, csrfSource: source });
  };

  const selectors = [
    'input[name="csrfToken"]',
    'input[name="csrf-token"]',
    'input[name="_csrf"]',
    'input[name="csrf"]',
    'meta[name="csrf-token"]',
    'meta[name="csrfToken"]',
    "[data-csrf-token]",
    "[data-csrf]",
  ];
  for (const selector of selectors) {
    try {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        addCandidate(el.value || el.content || el.getAttribute("content") || el.getAttribute("data-csrf-token") || el.getAttribute("data-csrf"), "selector");
      }
    } catch { }
  }

  const keyLooksRelevant = (key) => /csrf|csrftoken|antiCsrf|anti-csrf|token/i.test(String(key || ""));
  try {
    for (const key of Object.keys(window)) {
      if (keyLooksRelevant(key)) addCandidate(window[key], "window");
      const value = window[key];
      if (value && typeof value === "object") {
        for (const nestedKey of Object.keys(value).slice(0, 200)) {
          if (keyLooksRelevant(nestedKey)) addCandidate(value[nestedKey], "window");
        }
      }
    }
  } catch { }

  const scriptText = Array.from(document.scripts || [])
    .map((script) => script.textContent || "")
    .join("\n")
    .slice(0, 2000000);
  const pageText = `${document.documentElement?.innerHTML || ""}\n${scriptText}`;
  const regexes = [
    /csrfToken["']?\s*[:=]\s*["']([^"']+)["']/gi,
    /csrf-token["']?\s*[:=]\s*["']([^"']+)["']/gi,
    /csrf_token["']?\s*[:=]\s*["']([^"']+)["']/gi,
    /["']csrfToken["']\s*:\s*["']([^"']+)["']/gi,
    /'csrfToken'\s*:\s*'([^']+)'/gi,
  ];
  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(pageText))) addCandidate(match[1], "scriptRegex");
  }

  const best = candidates.sort((a, b) => b.csrfToken.length - a.csrfToken.length)[0];
  return {
    csrfToken: best?.csrfToken || "",
    csrfSource: best?.csrfSource || "none",
    csrfTokenLength: best?.csrfToken?.length || 0,
  };
}

function extractAmazonCsrfFromText(text = "") {
  const csrfMatches = [
    /csrfToken['"]\s*:\s*['"]([^'"]+)['"]/i,
    /name=['"]csrfToken['"][^>]*value=['"]([^'"]+)['"]/i,
    /anti-csrftoken-a2z['"]\s*:\s*['"]([^'"]+)['"]/i,
    /"csrfToken"\s*:\s*"([^"]+)"/i,
    /window\.csrfToken\s*=\s*['"]([^'"]+)['"]/i,
    /data-csrf-token=['"]([^'"]+)['"]/i,
    /<meta[^>]+name=['"]csrf-token['"][^>]+content=['"]([^'"]+)['"]/i,
  ];

  for (const regex of csrfMatches) {
    const match = String(text || "").match(regex);
    if (match?.[1]) return match[1];
  }
  return "";
}

async function waitForSellerCentralTabComplete(tabId, timeoutMs = 35000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (existing?.status === "complete") return true;

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onUpdated = (tid, info) => {
      if (tid === tabId && info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function findOrOpenSellerCentralFeedsTab({ tabId = null, dedicated = false, active = true } = {}) {
  let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab?.id) {
    if (shouldNavigateSellerCentralFeedsTab({ currentUrl: tab.url, targetUrl: SC_FEEDS_URL })) {
      tab = await chrome.tabs.update(tab.id, { url: SC_FEEDS_URL, active });
    } else if (active) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      tab = await chrome.tabs.update(tab.id, { active: true });
    }
    return tab;
  }

  if (dedicated) {
    return chrome.tabs.create({ url: SC_FEEDS_URL, active });
  }

  const tabs = await chrome.tabs.query({ url: `${SC_BASE}/*` }).catch(() => []);
  const feedsTab = tabs.find((tab) => !shouldNavigateSellerCentralFeedsTab({ currentUrl: tab.url, targetUrl: SC_FEEDS_URL }));
  tab = feedsTab || tabs[0];

  if (tab?.id) {
    if (feedsTab) {
      if (active) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        tab = await chrome.tabs.update(tab.id, { active: true });
      }
      return tab;
    }
    return chrome.tabs.update(tab.id, { url: SC_FEEDS_URL, active: true });
  }

  return chrome.tabs.create({ url: SC_FEEDS_URL, active });
}

async function warmUpUploadFeedFormReadOnly(tabId) {
  if (!tabId) return { clicked: false, reason: "missing_tab" };
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [getReadOnlyUploadFeedWarmupSelectors()],
    func: (selectors) => {
      const isUploadControl = (element) => /upload|add\s+file|new\s+upload/i.test(
        `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`
      );
      const target = selectors
        .flatMap((selector) => [...document.querySelectorAll(selector)])
        .find((element) => !element.disabled && isUploadControl(element));
      if (!target) return { clicked: false, reason: "upload_control_not_found" };
      target.click();
      return { clicked: true, control: target.getAttribute("aria-label") || target.textContent?.trim() || "upload" };
    },
  }).catch((error) => [{ result: { clicked: false, reason: error?.message || "warmup_failed" } }]);
  return result?.result || { clicked: false, reason: "warmup_failed" };
}

async function seedUploadFeedCsrfFromSellerCentralTab(tabId) {
  const existing = await getUploadFeedCsrfCacheStatus();
  if (existing.valid || !tabId) return existing;

  const cookieToken = await getCookie(`${SC_BASE}/`, "anti-csrftoken-a2z");
  let { token: pageToken, storageToken, pageHint } = await getSellerCentralPageCsrfFromTab(tabId);
  let capture = {
    ...selectReadOnlyUploadFeedCsrfCapture({ cookieToken, storageToken, pageToken }),
    url: pageHint?.href || SC_FEEDS_URL,
    pageTitle: pageHint?.title || "Seller Central Feeds",
  };

  if (!isValidUploadFeedCsrfToken(capture.token)) {
    const warmup = await warmUpUploadFeedFormReadOnly(tabId);
    if (warmup.clicked) {
      await delayMs(800);
      ({ token: pageToken, storageToken, pageHint } = await getSellerCentralPageCsrfFromTab(tabId));
      capture = {
        ...selectReadOnlyUploadFeedCsrfCapture({ cookieToken, storageToken, pageToken }),
        url: pageHint?.href || SC_FEEDS_URL,
        pageTitle: pageHint?.title || "Seller Central Feeds",
      };
    }
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] read-only upload form warm-up", {
      tabId,
      clicked: warmup.clicked,
      reason: warmup.reason || "",
      tokenFound: isValidUploadFeedCsrfToken(capture.token),
    }, warmup.clicked ? "info" : "error");
  }

  if (isValidUploadFeedCsrfToken(capture.token)) {
    await saveUploadFeedCsrfTokenCapture(capture);
  }
  return getUploadFeedCsrfCacheStatus();
}

const uploadFeedCsrfDiagnosticAtByTab = new Map();

async function logUploadFeedCsrfDiagnostic(tabId) {
  const now = Date.now();
  if (!tabId || now - (uploadFeedCsrfDiagnosticAtByTab.get(tabId) || 0) < 30000) return;
  uploadFeedCsrfDiagnosticAtByTab.set(tabId, now);

  const cookies = await chrome.cookies.getAll({ url: `${SC_BASE}/` }).catch(() => []);
  const [pageResult] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: () => {
      const keysMatching = (storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter((key) => /csrf|token/i.test(String(key || "")));
      return {
        formFields: Array.from(document.querySelectorAll("input, select, textarea"))
          .map((element) => element.getAttribute("name") || element.getAttribute("id") || "")
          .filter(Boolean),
        localStorageKeys: keysMatching(localStorage),
        sessionStorageKeys: keysMatching(sessionStorage),
        windowKeys: Object.keys(window).filter((key) => /csrf|token/i.test(key)),
        scriptMentionsCsrf: Array.from(document.scripts || []).some((script) => /csrf/i.test(script.textContent || "")),
        nativeUploadForm: (() => {
          const fileInput = document.querySelector('input[type="file"]');
          const form = fileInput?.closest("form") || null;
          const labelOf = (element) => element.getAttribute("aria-label") || element.value || element.textContent || "";
          return {
            action: form?.action || "",
            method: form?.method || "",
            fileInputCount: document.querySelectorAll('input[type="file"]').length,
            submitControls: Array.from(form?.querySelectorAll('button, input[type="submit"]') || [])
              .map(labelOf)
              .map((value) => value.trim())
              .filter(Boolean),
            availableControls: Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
              .map(labelOf)
              .map((value) => value.trim())
              .filter(Boolean)
              .slice(0, 30),
          };
        })(),
      };
    },
  }).catch(() => []);
  const diagnostic = buildSafeUploadFeedCsrfDiagnostic({
    cookieNames: cookies.map((cookie) => cookie.name),
    page: pageResult?.result || {},
  });
  logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF read-only diagnostic", diagnostic);
  logUploadTrackingDiagnostic(
    "[UPLOAD_TRACKING] native upload form diagnostic",
    summarizeNativeUploadForm(pageResult?.result?.nativeUploadForm),
  );
}

async function installUploadFeedCsrfSniffer(tabId) {
  if (!tabId) return { ok: false, error: "missing_tab_id" };

  const bridge = () => {
    if (window.__APO_UPLOADFEED_CSRF_BRIDGE_INSTALLED__) return true;
    window.__APO_UPLOADFEED_CSRF_BRIDGE_INSTALLED__ = true;
    window.addEventListener("message", (event) => {
      try {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.__apoUploadFeedDebug === true) {
          chrome.runtime.sendMessage({
            type: "UPLOADFEED_SNIFFER_DEBUG",
            payload: {
              event: String(data.event || ""),
              href: String(data.href || location.href),
              title: String(data.title || document.title),
              installedAt: Number(data.installedAt || 0),
            },
          }).catch(() => { });
          return;
        }
        if (data.__apoUploadFeedCsrfCaptured === true) {
          chrome.runtime.sendMessage({
            type: "UPLOADFEED_CSRF_CAPTURED",
            payload: {
              token: String(data.token || ""),
              source: String(data.source || ""),
              url: String(data.url || location.href),
              pageTitle: String(data.pageTitle || document.title),
              capturedAt: Number(data.capturedAt || Date.now()),
              isTestToken: !!data.isTestToken,
            },
          }).catch(() => { });
        }
      } catch { }
    });
    return true;
  };

  const sniffer = (flagName, uploadPath) => {
    const installedAt = Date.now();
    window[flagName] = true;
    window.__APO_UPLOADFEED_SNIFFER_INSTALLED__ = true;
    window.__APO_UPLOADFEED_SNIFFER_INSTALLED_AT__ = installedAt;

    const originalConsoleLog = window.__APO_UPLOADFEED_NATIVE_CONSOLE_LOG__ || console.log.bind(console);
    window.__APO_UPLOADFEED_NATIVE_CONSOLE_LOG__ = originalConsoleLog;

    const isValidToken = (value) => {
      const token = String(value || "").trim();
      if (!token) return false;
      if (token.length < 80) return false;
      if (/^(undefined|null|true|false)$/i.test(token)) return false;
      return /^[A-Za-z0-9+/=_-]+$/.test(token);
    };

    const isUploadFeedUrl = (url) => String(url || "").includes(uploadPath);
    const fieldNamesOf = (body) => {
      try {
        if (!(body instanceof FormData)) return [];
        return Array.from(body.keys());
      } catch {
        return [];
      }
    };

    const postDebug = (event, fields = {}) => {
      try {
        window.postMessage({
          __apoUploadFeedDebug: true,
          event,
          href: location.href,
          title: document.title,
          installedAt,
          ...fields,
        }, "*");
      } catch { }
    };

    const publish = (token, source, extra = {}) => {
      try {
        const value = String(token || "").trim();
        if (!isValidToken(value)) return false;
        originalConsoleLog(`[APO_UPLOADFEED_SNIFFER] csrfToken captured from ${source}`, {
          source,
          tokenLength: value.length,
          isTestToken: !!extra.isTestToken,
        });
        window.postMessage({
          __apoUploadFeedCsrfCaptured: true,
          token: value,
          source,
          url: location.href,
          pageTitle: document.title,
          capturedAt: Date.now(),
          isTestToken: !!extra.isTestToken,
        }, "*");
        return true;
      } catch {
        return false;
      }
    };

    const findTokenDeep = (value, seen = new WeakSet()) => {
      try {
        if (isValidToken(value)) return String(value).trim();
        if (!value || typeof value !== "object") return "";
        if (seen.has(value)) return "";
        seen.add(value);
        if (value instanceof FormData) {
          const token = value.get("csrfToken");
          return isValidToken(token) ? String(token).trim() : "";
        }
        if (isValidToken(value.csrfToken)) return String(value.csrfToken).trim();
        for (const key of Object.keys(value).slice(0, 100)) {
          const found = findTokenDeep(value[key], seen);
          if (found) return found;
        }
      } catch { }
      return "";
    };

    const inspectConsoleArgs = (args) => {
      try {
        for (const arg of args) {
          if (!arg || typeof arg !== "object") continue;
          const relevant = arg.type === "UPLOAD_ACTION" || arg.feedTypeName === "confirmShipment";
          if (!relevant) continue;
          const token = findTokenDeep(arg);
          if (token) publish(token, "consoleLog", { isTestToken: !!arg.__apoTestToken });
        }
      } catch { }
    };

    const inspectFormData = (body, source) => {
      let csrf = "";
      let names = [];
      try {
        names = fieldNamesOf(body);
        if (body instanceof FormData) csrf = body.get("csrfToken");
      } catch { }
      const csrfIncluded = isValidToken(csrf);
      originalConsoleLog("[APO_UPLOADFEED_SNIFFER] uploadFeed request detected", {
        source,
        hasFormData: body instanceof FormData,
        fieldNames: names,
        csrfIncluded,
        csrfTokenLength: csrfIncluded ? String(csrf).trim().length : 0,
      });
      if (csrfIncluded) publish(csrf, source);
    };

    try {
      const nativeAppend = FormData.prototype.append;
      if (typeof nativeAppend === "function" && !nativeAppend.__apoUploadFeedPatched) {
        const patchedAppend = function (name, value, filename) {
          try {
            if (String(name) === "csrfToken") publish(value, "formDataAppend");
          } catch { }
          return nativeAppend.apply(this, arguments);
        };
        patchedAppend.__apoUploadFeedPatched = true;
        FormData.prototype.append = patchedAppend;
      }
    } catch { }

    try {
      const nativeSet = FormData.prototype.set;
      if (typeof nativeSet === "function" && !nativeSet.__apoUploadFeedPatched) {
        const patchedSet = function (name, value, filename) {
          try {
            if (String(name) === "csrfToken") publish(value, "formDataSet");
          } catch { }
          return nativeSet.apply(this, arguments);
        };
        patchedSet.__apoUploadFeedPatched = true;
        FormData.prototype.set = patchedSet;
      }
    } catch { }

    try {
      const nativeConsoleLog = console.log;
      if (!nativeConsoleLog.__apoUploadFeedPatched) {
        const patchedConsoleLog = function (...args) {
          try {
            inspectConsoleArgs(args);
          } catch { }
          return originalConsoleLog(...args);
        };
        patchedConsoleLog.__apoUploadFeedPatched = true;
        console.log = patchedConsoleLog;
      }
    } catch { }

    try {
      const NativeRequest = window.Request;
      if (typeof NativeRequest === "function" && !NativeRequest.__apoUploadFeedPatched) {
        const PatchedRequest = function (input, init = {}) {
          try {
            const url = typeof input === "string" ? input : input?.url;
            const body = init?.body || input?.body;
            if (isUploadFeedUrl(url)) inspectFormData(body, "requestFormData");
          } catch { }
          return new NativeRequest(input, init);
        };
        Object.setPrototypeOf(PatchedRequest, NativeRequest);
        PatchedRequest.prototype = NativeRequest.prototype;
        PatchedRequest.__apoUploadFeedPatched = true;
        window.Request = PatchedRequest;
      }
    } catch { }

    try {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch === "function" && !nativeFetch.__apoUploadFeedPatched) {
        const patchedFetch = function (input, init = {}) {
          try {
            const url = typeof input === "string" ? input : input?.url;
            const body = init?.body;
            if (isUploadFeedUrl(url)) inspectFormData(body, "fetchFormData");
          } catch { }
          return nativeFetch.apply(this, arguments);
        };
        patchedFetch.__apoUploadFeedPatched = true;
        window.fetch = patchedFetch;
      }
    } catch { }

    try {
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;
      if (typeof nativeOpen === "function" && typeof nativeSend === "function" && !nativeSend.__apoUploadFeedPatched) {
        XMLHttpRequest.prototype.open = function (method, url) {
          try {
            this.__apoUploadFeedUrl = url;
          } catch { }
          return nativeOpen.apply(this, arguments);
        };
        const patchedSend = function (body) {
          try {
            if (isUploadFeedUrl(this.__apoUploadFeedUrl)) inspectFormData(body, "xhrFormData");
          } catch { }
          return nativeSend.apply(this, arguments);
        };
        patchedSend.__apoUploadFeedPatched = true;
        XMLHttpRequest.prototype.send = patchedSend;
      }
    } catch { }

    const status = {
      href: location.href,
      title: document.title,
      installedAt,
      fetchPatched: !!window.fetch?.__apoUploadFeedPatched,
      requestPatched: !!window.Request?.__apoUploadFeedPatched,
      xhrPatched: !!XMLHttpRequest.prototype.send?.__apoUploadFeedPatched,
      formDataAppendPatched: !!FormData.prototype.append?.__apoUploadFeedPatched,
      formDataSetPatched: !!FormData.prototype.set?.__apoUploadFeedPatched,
      consoleLogPatched: !!console.log?.__apoUploadFeedPatched,
    };
    originalConsoleLog("[APO_UPLOADFEED_SNIFFER] MAIN sniffer installed", status);
    postDebug("snifferInstalled", status);
    return true;
  };

  await chrome.scripting.executeScript({
    target: { tabId },
    func: bridge,
    world: "ISOLATED",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: sniffer,
    args: [AMAZON_UPLOADFEED_SNIFFER_FLAG, AMAZON_UPLOADFEED_URL_PATH],
    world: "MAIN",
  });

  return { ok: true, tabId };
}

globalThis.installUploadFeedSnifferNow = async function () {
  const tab = await findOrOpenSellerCentralFeedsTab();
  if (!tab?.id) {
    return { ok: false, error: "Unable to open Seller Central feeds tab" };
  }

  await waitForSellerCentralTabComplete(tab.id);
  await delayMs(1000);

  const result = await installUploadFeedCsrfSniffer(tab.id);

  return {
    ok: true,
    tabId: tab.id,
    result
  };
};

globalThis.verifyUploadFeedSnifferNow = async function () {
  const tab = await findOrOpenSellerCentralFeedsTab();
  if (!tab?.id) {
    return { ok: false, error: "Unable to open Seller Central feeds tab" };
  }

  await waitForSellerCentralTabComplete(tab.id);

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: () => ({
      mainWorldFlag: !!window.__APO_UPLOADFEED_SNIFFER_INSTALLED__,
      installedAt: window.__APO_UPLOADFEED_SNIFFER_INSTALLED_AT__ || 0,
      href: location.href,
      title: document.title,
      fetchPatched: !!window.fetch?.__apoUploadFeedPatched,
      requestPatched: !!window.Request?.__apoUploadFeedPatched,
      xhrPatched: !!XMLHttpRequest.prototype.send?.__apoUploadFeedPatched,
      formDataAppendPatched: !!FormData.prototype.append?.__apoUploadFeedPatched,
      formDataSetPatched: !!FormData.prototype.set?.__apoUploadFeedPatched,
      consoleLogPatched: !!console.log?.__apoUploadFeedPatched,
    }),
  });

  return {
    ok: true,
    tabId: tab.id,
    ...(res?.result || {})
  };
};

globalThis.checkUploadFeedCsrfCacheNow = async function () {
  const cache = await getCachedUploadFeedCsrfToken();

  return {
    ok: true,
    tokenFound: !!cache,
    tokenLength: cache?.tokenLength || 0,
    source: cache?.source || "none",
    ageMs: cache?.capturedAt ? Date.now() - cache.capturedAt : null,
    valid: !!cache,
    isTestToken: !!cache?.isTestToken
  };
};

globalThis.clearUploadFeedCsrfCacheNow = async function () {
  return clearUploadFeedCsrfCache("manual_service_worker_console");
};

globalThis.testUploadFeedSnifferCaptureNow = async function () {
  const tab = await findOrOpenSellerCentralFeedsTab();
  if (!tab?.id) {
    return { ok: false, error: "Unable to open Seller Central feeds tab" };
  }

  await waitForSellerCentralTabComplete(tab.id);
  await installUploadFeedCsrfSniffer(tab.id);

  const fakeToken =
    "TEST" +
    "A".repeat(120) +
    "==";

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (token) => {
      console.log("dispatching", {
        type: "UPLOAD_ACTION",
        feedTypeName: "confirmShipment",
        payload: {
          csrfToken: token
        },
        __apoTestToken: true
      });

      return {
        ok: true,
        href: location.href,
        title: document.title,
        tokenLength: token.length
      };
    },
    args: [fakeToken],
  });

  return {
    ok: true,
    tabId: tab.id,
    result: res?.result || null
  };
};

console.log("[UPLOAD_TRACKING] Service Worker uploadFeed debug helpers exposed", {
  installUploadFeedSnifferNow: typeof globalThis.installUploadFeedSnifferNow,
  verifyUploadFeedSnifferNow: typeof globalThis.verifyUploadFeedSnifferNow,
  checkUploadFeedCsrfCacheNow: typeof globalThis.checkUploadFeedCsrfCacheNow,
  clearUploadFeedCsrfCacheNow: typeof globalThis.clearUploadFeedCsrfCacheNow,
  testUploadFeedSnifferCaptureNow: typeof globalThis.testUploadFeedSnifferCaptureNow
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status !== "complete") return;
    const url = tab?.url || "";
    if (!url.startsWith(SC_FEEDS_URL)) return;
    Promise.resolve(installUploadFeedCsrfSniffer(tabId))
      .then(async (result) => {
        if (result?.ok) await logUploadFeedCsrfDiagnostic(tabId);
        logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF sniffer auto-installed on feeds tab", {
          tabId,
          url,
          ok: !!result?.ok,
        }, result?.ok ? "success" : "error");
      })
      .catch((error) => {
        logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF sniffer auto-install failed on feeds tab", {
          tabId,
          url,
          error: error?.message || String(error),
        }, "error");
      });
  } catch (error) {
    console.warn("[UPLOAD_TRACKING] feeds tab sniffer auto-install exception:", error?.message || error);
  }
});

async function getSellerCentralPageCsrfFromTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const inputs = Array.from(document.querySelectorAll(
          'input[name="csrfToken"], input[name="anti-csrftoken-a2z"], meta[name="csrf-token"], [data-csrf-token]'
        ));
        const tokenFromDom = inputs
          .map((el) => el.value || el.content || el.getAttribute("data-csrf-token") || "")
          .find(Boolean) || "";

        let initialState = "";
        try {
          initialState = JSON.stringify(window.__INITIAL_STATE__ || {});
        } catch {
          initialState = "";
        }
        const pageText = [
          document.documentElement?.innerHTML || "",
          initialState,
        ].join("\n");

        return {
          href: location.href,
          title: document.title,
          tokenFromDom,
          tokenFromHtml: (() => {
            const patterns = [
              /csrfToken['"]\s*:\s*['"]([^'"]+)['"]/i,
              /anti-csrftoken-a2z['"]\s*:\s*['"]([^'"]+)['"]/i,
              /"csrfToken"\s*:\s*"([^"]+)"/i,
              /window\.csrfToken\s*=\s*['"]([^'"]+)['"]/i,
              /data-csrf-token=['"]([^'"]+)['"]/i,
            ];
            for (const pattern of patterns) {
              const match = pageText.match(pattern);
              if (match?.[1]) return match[1];
            }
            return "";
          })(),
          storageTokens: Object.keys(localStorage)
            .filter((key) => /^csa-ctoken-/i.test(key))
            .map((key) => localStorage.getItem(key) || ""),
          bodyText: (document.body?.innerText || "").slice(0, 1200),
        };
      },
    });

    const result = res?.result || {};
    const storageToken = (result.storageTokens || []).find((value) => isValidUploadFeedCsrfToken(value)) || "";
    const { storageTokens, ...safePageHint } = result;
    return {
      token: result.tokenFromDom || result.tokenFromHtml || "",
      storageToken,
      pageHint: safePageHint,
    };
  } catch (error) {
    return {
      token: "",
      storageToken: "",
      pageHint: { error: error?.message || String(error) },
    };
  }
}

async function refreshSellerCentralUploadAuth() {
  debugLog("[UPLOAD_TRACKING] Refreshing Seller Central auth in tab", "info");
  const tab = await findOrOpenSellerCentralFeedsTab();
  if (!tab?.id) {
    throw createAmazonUploadError(
      "AMAZON_CSRF_MISSING",
      "Cannot open Seller Central feeds tab to refresh authentication. Open Seller Central, log in, then retry."
    );
  }

  await waitForSellerCentralTabComplete(tab.id);
  await delayMs(1500);

  const cookieToken = await getCookie(`${SC_BASE}/`, "anti-csrftoken-a2z");
  const { token: pageToken, storageToken, pageHint } = await getSellerCentralPageCsrfFromTab(tab.id);
  const csrfToken = cookieToken || storageToken || pageToken || "";

  extensionLogger?.logInfo("[UPLOAD_TRACKING] Seller Central auth refresh completed", {
    tabId: tab.id,
    url: pageHint?.href,
    title: pageHint?.title,
    cookieTokenFound: !!cookieToken,
    storageTokenFound: !!storageToken,
    pageTokenFound: !!pageToken,
  });

  if (!csrfToken) {
    throw createAmazonUploadError(
      "AMAZON_CSRF_MISSING",
      "Amazon Seller Central CSRF token is missing. Log in to Seller Central, refresh the feeds page, then retry the tracking upload.",
      { pageHint }
    );
  }

  return csrfToken;
}

const AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE = "America/Los_Angeles";

function formatDateYmdInTimeZone(date = new Date(), timeZone = AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const safeDate = Number.isNaN(d.getTime()) ? new Date() : d;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(safeDate);

  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function compareYmd(a = "", b = "") {
  return String(a || "").localeCompare(String(b || ""));
}

function normalizeShipDateForAmazonConfirmShipment(value = new Date(), options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const marketplaceToday = formatDateYmdInTimeZone(
    now,
    AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE
  );

  const raw = String(value || "").trim();
  let candidate = "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    candidate = raw;
  } else {
    const parsed = value instanceof Date ? value : new Date(raw || now);
    candidate = Number.isNaN(parsed.getTime())
      ? marketplaceToday
      : formatDateYmdInTimeZone(parsed, AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE);
  }

  if (compareYmd(candidate, marketplaceToday) > 0) {
    return marketplaceToday;
  }

  return candidate || marketplaceToday;
}

function isHtmlResponse(contentType = "", text = "") {
  const ct = String(contentType || "").toLowerCase();
  const body = String(text || "").trimStart().toLowerCase();
  return ct.includes("text/html") || body.startsWith("<!doctype html") || body.startsWith("<html") || body.includes("<html");
}

function classifyAmazonUploadFailure(response, responseText = "") {
  const contentType = response.headers.get("content-type") || "";
  const bodyAndUrl = `${response?.url || ""}\n${responseText || ""}`;
  const authLike = /signin|sign-in|login|authentication|captcha|session expired|unauthorized|forbidden/i.test(bodyAndUrl);
  if (response.status === 0) return "AMAZON_UPLOAD_CONTEXT_BLOCKED";
  if (response.status === 401 || response.status === 403) return "AMAZON_AUTH_REQUIRED";
  if (isHtmlResponse(contentType, responseText) && authLike) return "AMAZON_AUTH_REQUIRED";
  if (response.status === 400 && isHtmlResponse(contentType, responseText)) return "AMAZON_UPLOAD_BAD_REQUEST_HTML";
  if (response.status === 400) return "AMAZON_UPLOAD_BAD_REQUEST";
  if (response.status === 500) return "AMAZON_UPLOAD_SERVER_ERROR";
  return "AMAZON_UPLOAD_FAILED";
}

function isUploadFeedAuthOrCsrfError(error = {}) {
  const code = error?.code || "";
  const status = Number(error?.status || 0);
  if (["AMAZON_AUTH_REQUIRED", "AMAZON_UPLOAD_CSRF_FORM_FIELD_MISSING", "AMAZON_UPLOAD_CSRF_SEED_REQUIRED"].includes(code)) return true;
  if (status === 401 || status === 403) return true;
  const responseText = String(error?.responseText || "");
  if (responseText && /signin|sign-in|login|authentication|captcha|session expired|unauthorized|forbidden|csrf|token/i.test(responseText)) return true;
  return false;
}

async function getSellerCentralUploadPagePreflight(context = {}) {
  const tab = await findOrOpenSellerCentralFeedsTab({ tabId: context.sellerCentralTabId || null });
  if (!tab?.id) {
    return {
      ok: false,
      tabId: null,
      finalUrl: "",
      pageTitle: "",
      tabStatus: "",
      feedsPage: false,
      isLoginPage: false,
      isOtpPage: false,
      isCaptchaPage: false,
      isMarketplaceSelector: false,
      isSellerCentralPage: false,
      allowUpload: false,
      error: "Unable to open Seller Central feeds tab",
      context,
    };
  }

  await waitForSellerCentralTabComplete(tab.id);
  await delayMs(1500);
  const currentTab = await chrome.tabs.get(tab.id).catch(() => tab);

  let pageInfo = {};
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: (document.body?.innerText || "").slice(0, 1200),
      }),
    });
    pageInfo = res?.result || {};
  } catch (error) {
    pageInfo = { error: error?.message || String(error) };
  }

  const finalUrl = pageInfo.href || currentTab?.url || "";
  const pageTitle = pageInfo.title || currentTab?.title || "";
  let snifferInstalled = false;
  try {
    const snifferResult = await installUploadFeedCsrfSniffer(tab.id);
    snifferInstalled = !!snifferResult?.ok;
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF sniffer installed", {
      tabId: tab.id,
      finalUrl,
      pageTitle,
      snifferInstalled,
    }, snifferInstalled ? "success" : "error");
  } catch (error) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF sniffer install failed", {
      tabId: tab.id,
      finalUrl,
      pageTitle,
      error: error?.message || String(error),
    }, "error");
  }
  const bodyText = String(pageInfo.bodyText || "");
  const haystack = `${finalUrl}\n${pageTitle}\n${bodyText}`.toLowerCase();
  const feedsPage = finalUrl.includes(AMAZON_UPLOADFEED_PAGE_URL);
  const isLoginPage = /signin|sign-in|ap\/signin|login|password|passkey|authentication/.test(haystack);
  const isOtpPage = /otp|one time password|one-time password|two-step|two step|verification code/.test(haystack);
  const isCaptchaPage = /captcha|enter the characters|type the characters/.test(haystack);
  const isMarketplaceSelector = /marketplace|select.*marketplace|choose.*marketplace|seller central.*country/.test(haystack) && !feedsPage;
  const isSellerCentralPage = finalUrl.includes("sellercentral.amazon.com");
  const allowUpload = feedsPage && isSellerCentralPage && !isLoginPage && !isOtpPage && !isCaptchaPage && !isMarketplaceSelector;

  return {
    ok: allowUpload,
    tabId: tab.id,
    finalUrl,
    pageTitle,
    tabStatus: currentTab?.status || pageInfo.readyState || "",
    feedsPage,
    isLoginPage,
    isOtpPage,
    isCaptchaPage,
    isMarketplaceSelector,
    isSellerCentralPage,
    allowUpload,
    snifferInstalled,
  };
}

async function getUploadFeedReadinessStatus(options = {}) {
  const requireSocket = !!options.requireSocket;
  const socketConnected = !!socket?.connected;
  let preflight = options.preflight || null;

  if (!options.skipSellerCentralPreflight && !preflight) {
    preflight = await getSellerCentralUploadPagePreflight({ reason: "readiness_status" });
  }

  const sellerCentralReady = options.skipSellerCentralPreflight && !preflight ? true : !!preflight?.allowUpload;
  const sellerCentralTabId = preflight?.tabId || null;
  if (sellerCentralTabId) await logUploadFeedCsrfDiagnostic(sellerCentralTabId);
  const sellerCentralUrl = preflight?.finalUrl || "";
  const sellerCentralTitle = preflight?.pageTitle || "";
  const needLogin = !!(preflight && (
    preflight.isLoginPage ||
    preflight.isOtpPage ||
    preflight.isCaptchaPage ||
    preflight.isMarketplaceSelector ||
    !preflight.allowUpload
  ));

  let cacheStatus = await getUploadFeedCsrfCacheStatus();
  if (sellerCentralReady && !cacheStatus.valid) {
    cacheStatus = await seedUploadFeedCsrfFromSellerCentralTab(sellerCentralTabId);
  }
  const csrfCacheValid = !!cacheStatus.valid;
  const needCsrfSeed = sellerCentralReady && !csrfCacheValid;
  const socketOk = !requireSocket || socketConnected;
  const ok = socketOk && sellerCentralReady && csrfCacheValid && !cacheStatus.isTestToken;

  let message = "UploadFeed is ready.";
  if (!socketOk) {
    message = "Socket is disconnected.";
  } else if (needLogin) {
    message = "Seller Central feeds page is not ready. Log in and clear any OTP, captcha, or marketplace selector.";
  } else if (needCsrfSeed) {
    message = "Open Seller Central feeds page and perform one manual upload to seed uploadFeed csrfToken.";
  }

  return {
    ok,
    socketConnected,
    sellerCentralReady,
    sellerCentralTabId,
    sellerCentralUrl,
    sellerCentralTitle,
    csrfCacheValid,
    csrfTokenFound: cacheStatus.tokenFound,
    csrfTokenLength: cacheStatus.tokenLength,
    csrfSource: cacheStatus.source,
    csrfAgeMs: cacheStatus.ageMs,
    csrfAgeMin: cacheStatus.ageMin,
    isTestToken: cacheStatus.isTestToken,
    needLogin,
    needCsrfSeed,
    message,
  };
}

// TODO Phase 2: add throttled uploadFeed session warm-up, identity-scoped CSRF cache metadata,
// an upload tracking lock, and Amazon uploadFeed batchId persistence after Phase 1 runs cleanly.

/*
 * Expected manual request contract:
 * POST /order-reports-and-feeds/api/uploadFeed
 * FormData:
 * - feedFile
 * - feedName=confirmShipment
 * - feedVersion=new
 * - csrfToken=<long token>
  */
async function uploadToAmazonFromSellerCentralTab(stableFileObj, uploadParams = {}) {
  const tab = await findOrOpenSellerCentralFeedsTab({ tabId: uploadParams.sellerCentralTabId || null });
  if (!tab?.id) {
    return {
      ok: false,
      status: 0,
      code: "AMAZON_UPLOAD_CONTEXT_BLOCKED",
      statusText: "Seller Central feeds tab is unavailable",
      csrfIncluded: false,
      csrfSource: "none",
      csrfTokenLength: 0,
      url: "",
      contentType: "",
      textPreview: "Unable to open Seller Central feeds tab",
      jsonParseOk: false,
      json: null,
      world: "",
    };
  }

  await waitForSellerCentralTabComplete(tab.id);
  await delayMs(1000);
  let snifferInstalled = false;
  try {
    const snifferResult = await installUploadFeedCsrfSniffer(tab.id);
    snifferInstalled = !!snifferResult?.ok;
  } catch (error) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF sniffer install failed before upload", {
      tabId: tab.id,
      error: error?.message || String(error),
    }, "error");
  }
  const cachedCsrf = await getCachedUploadFeedCsrfToken();

  const fileText = await stableFileObj.text();
  const filename = stableFileObj.name || uploadParams.filename || "confirmShipment.txt";
  const contentType = stableFileObj.type || uploadParams.contentType || "text/tab-separated-values; charset=utf-8";

  const injectedUpload = async (fileTextArg, filenameArg, contentTypeArg, pathArg, cachedTokenArg, snifferInstalledArg) => {
    const extractUploadFeedCsrfTokenInPage = () => {
      const MIN_CSRF_LENGTH = 80;
      const isValid = (value) => {
        const token = String(value || "").trim();
        if (!token) return false;
        if (token.length < MIN_CSRF_LENGTH) return false;
        if (/^(undefined|null|true|false)$/i.test(token)) return false;
        return /^[A-Za-z0-9+/=_-]+$/.test(token);
      };
      const candidates = [];
      const addCandidate = (value, source) => {
        const token = String(value || "").trim();
        if (isValid(token)) candidates.push({ csrfToken: token, csrfSource: source });
      };
      const selectors = [
        'input[name="csrfToken"]',
        'input[name="csrf-token"]',
        'input[name="_csrf"]',
        'input[name="csrf"]',
        'meta[name="csrf-token"]',
        'meta[name="csrfToken"]',
        "[data-csrf-token]",
        "[data-csrf]",
      ];
      for (const selector of selectors) {
        try {
          for (const el of Array.from(document.querySelectorAll(selector))) {
            addCandidate(el.value || el.content || el.getAttribute("content") || el.getAttribute("data-csrf-token") || el.getAttribute("data-csrf"), "selector");
          }
        } catch { }
      }
      const keyLooksRelevant = (key) => /csrf|csrftoken|antiCsrf|anti-csrf|token/i.test(String(key || ""));
      try {
        for (const key of Object.keys(window)) {
          if (keyLooksRelevant(key)) addCandidate(window[key], "window");
          const value = window[key];
          if (value && typeof value === "object") {
            for (const nestedKey of Object.keys(value).slice(0, 200)) {
              if (keyLooksRelevant(nestedKey)) addCandidate(value[nestedKey], "window");
            }
          }
        }
      } catch { }
      const scriptText = Array.from(document.scripts || []).map((script) => script.textContent || "").join("\n").slice(0, 2000000);
      const pageText = `${document.documentElement?.innerHTML || ""}\n${scriptText}`;
      const regexes = [
        /csrfToken["']?\s*[:=]\s*["']([^"']+)["']/gi,
        /csrf-token["']?\s*[:=]\s*["']([^"']+)["']/gi,
        /csrf_token["']?\s*[:=]\s*["']([^"']+)["']/gi,
        /["']csrfToken["']\s*:\s*["']([^"']+)["']/gi,
        /'csrfToken'\s*:\s*'([^']+)'/gi,
      ];
      for (const regex of regexes) {
        let match;
        while ((match = regex.exec(pageText))) addCandidate(match[1], "scriptRegex");
      }
      const best = candidates.sort((a, b) => b.csrfToken.length - a.csrfToken.length)[0];
      return {
        csrfToken: best?.csrfToken || "",
        csrfSource: best?.csrfSource || "none",
        csrfTokenLength: best?.csrfToken?.length || 0,
      };
    };
    const tokenResult = extractUploadFeedCsrfTokenInPage();
    const isValidUploadFeedToken = (value) => {
      const token = String(value || "").trim();
      if (!token) return false;
      if (token.length < 80) return false;
      if (/^(undefined|null|true|false)$/i.test(token)) return false;
      return /^[A-Za-z0-9+/=_-]+$/.test(token);
    };
    const liveToken = tokenResult.csrfToken || "";
    const cachedToken = String(cachedTokenArg || "").trim();
    const liveExtractionFound = isValidUploadFeedToken(liveToken);
    const cachedTokenFound = isValidUploadFeedToken(cachedToken);
    const csrfToken = liveExtractionFound ? liveToken : cachedTokenFound ? cachedToken : "";
    const csrfSource = liveExtractionFound ? (tokenResult.csrfSource || "none") : cachedTokenFound ? "cachedSnifferToken" : "none";
    const csrfTokenLength = csrfToken.length;
    if (!csrfToken || csrfTokenLength < 80) {
      return {
        ok: false,
        status: 0,
        code: "AMAZON_UPLOAD_CSRF_FORM_FIELD_MISSING",
        statusText: "Valid uploadFeed csrfToken FormData field is missing",
        csrfIncluded: false,
        csrfSource: "none",
        csrfTokenLength: 0,
        url: location.href,
        finalUrl: location.href,
        pageTitle: document.title,
        readyState: document.readyState,
        isSellerCentralPage: location.href.includes("sellercentral.amazon.com"),
        isFeedsPage: location.href.includes("/order-reports-and-feeds/feeds"),
        liveExtractionFound,
        cachedTokenFound,
        snifferInstalled: !!snifferInstalledArg,
        instruction: "Open Seller Central feeds page and perform one manual upload to let the extension capture uploadFeed csrfToken.",
        contentType: "",
        textPreview: "No valid csrfToken found in Seller Central page context",
        jsonParseOk: false,
        json: null,
      };
    }

    const uploadFile = new File([fileTextArg], filenameArg, { type: contentTypeArg || "text/tab-separated-values; charset=utf-8" });
    const formData = new FormData();
    formData.append("feedFile", uploadFile);
    formData.append("feedName", "confirmShipment");
    formData.append("feedVersion", "new");
    formData.append("csrfToken", csrfToken);

    const res = await fetch(pathArg, {
      method: "POST",
      credentials: "include",
      headers: { accept: "*/*" },
      body: formData,
    });

    const responseContentType = res.headers.get("content-type") || "";
    const textBody = await res.text().catch(() => "");
    let json = null;
    let jsonParseOk = false;
    try {
      json = JSON.parse(textBody);
      jsonParseOk = true;
    } catch { }

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      redirected: res.redirected,
      type: res.type,
      contentType: responseContentType,
      textPreview: textBody.slice(0, 1000),
      jsonParseOk,
      json,
      csrfIncluded: true,
      csrfSource,
      csrfTokenLength,
      liveExtractionFound,
      cachedTokenFound,
      snifferInstalled: !!snifferInstalledArg,
    };
  };

  const runInjection = async (world) => {
    const options = {
      target: { tabId: tab.id },
      func: injectedUpload,
      args: [fileText, filename, contentType, AMAZON_UPLOADFEED_URL_PATH, cachedCsrf?.token || "", snifferInstalled],
    };
    if (world) options.world = world;
    const [res] = await chrome.scripting.executeScript(options);
    return { ...(res?.result || {}), world: world || "ISOLATED" };
  };

  try {
    return await runInjection("MAIN");
  } catch (error) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] MAIN world injection failed; using fallback isolated world", {
      error: error?.message || String(error),
      filename,
    }, "error");
    return await runInjection();
  }
}

async function uploadToAmazonViaNativeSellerCentralForm(stableFileObj, uploadParams = {}) {
  const tab = await findOrOpenSellerCentralFeedsTab({ tabId: uploadParams.sellerCentralTabId || null });
  if (!tab?.id) {
    return { ok: false, status: 0, code: "AMAZON_UPLOAD_CONTEXT_BLOCKED", textPreview: "Seller Central feeds tab is unavailable" };
  }

  await waitForSellerCentralTabComplete(tab.id);
  const fileText = await stableFileObj.text();
  const filename = stableFileObj.name || uploadParams.filename || "confirmShipment.txt";
  const contentType = stableFileObj.type || uploadParams.contentType || "text/tab-separated-values; charset=utf-8";
  const selectors = getNativeUploadFormSelectors();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [fileText, filename, contentType, selectors],
    func: async (fileTextArg, filenameArg, contentTypeArg, nativeSelectors) => {
      const input = document.querySelector(nativeSelectors.fileInput);
      const submit = document.querySelector(nativeSelectors.submit);
      if (!(input instanceof HTMLInputElement) || !(submit instanceof HTMLInputElement)) {
        return { ok: false, status: 0, code: "AMAZON_NATIVE_UPLOAD_CONTROL_MISSING", textPreview: "Seller Central native upload controls are unavailable" };
      }

      const transfer = new DataTransfer();
      transfer.items.add(new File([fileTextArg], filenameArg, { type: contentTypeArg }));
      try {
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (error) {
        return { ok: false, status: 0, code: "AMAZON_NATIVE_FILE_ASSIGN_FAILED", textPreview: error?.message || String(error) };
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      if (submit.disabled) {
        return { ok: false, status: 0, code: "AMAZON_NATIVE_UPLOAD_NOT_ENABLED", textPreview: "Seller Central did not enable Upload now after the file change" };
      }

      let settled = false;
      let resolveNetwork;
      const networkResult = new Promise((resolve) => { resolveNetwork = resolve; });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolveNetwork(value);
      };
      const nativeFetch = window.fetch;
      const nativeXhrOpen = XMLHttpRequest.prototype.open;
      const nativeXhrSend = XMLHttpRequest.prototype.send;
      window.fetch = async function (...args) {
        const response = await nativeFetch.apply(this, args);
        try {
          const text = await response.clone().text();
          finish({ status: response.status, statusText: response.statusText, url: response.url, contentType: response.headers.get("content-type") || "", textPreview: text.slice(0, 1000) });
        } catch { }
        return response;
      };
      XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this.__apoNativeUploadUrl = String(url || "");
        return nativeXhrOpen.call(this, method, url, ...args);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("loadend", () => {
          try {
            finish({
              status: this.status,
              statusText: this.statusText,
              url: this.responseURL || this.__apoNativeUploadUrl || "",
              contentType: this.getResponseHeader("content-type") || "",
              textPreview: typeof this.responseText === "string" ? this.responseText.slice(0, 1000) : "",
            });
          } catch { }
        }, { once: true });
        return nativeXhrSend.apply(this, args);
      };

      try {
        submit.click();
        const outcome = await Promise.race([
          networkResult,
          new Promise((resolve) => setTimeout(() => resolve(null), 30000)),
        ]);
        if (!outcome) {
          return { ok: false, status: 0, code: "AMAZON_NATIVE_UPLOAD_UNCONFIRMED", textPreview: "Seller Central did not expose an upload response within 30 seconds" };
        }
        let json = null;
        try { json = JSON.parse(outcome.textPreview || ""); } catch { }
        return {
          ok: outcome.status >= 200 && outcome.status < 300,
          ...outcome,
          json,
          jsonParseOk: json !== null,
          csrfIncluded: true,
          csrfSource: "nativeSellerCentralForm",
          csrfTokenLength: 0,
          nativeUi: true,
        };
      } finally {
        window.fetch = nativeFetch;
        XMLHttpRequest.prototype.open = nativeXhrOpen;
        XMLHttpRequest.prototype.send = nativeXhrSend;
      }
    },
  });
  return { ...(res?.result || {}), world: "MAIN" };
}

async function readAmazonFeedHistory(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => [...document.querySelectorAll("tr")].map((row) => {
      const cells = [...row.querySelectorAll("td")].map((cell) => cell.innerText.trim());
      const amazonBatchId = cells.find((cell) => /^\d{8,}$/.test(cell.replace(/\s/g, ""))) || "";
      const status = cells.find((cell) => /Status\s*:\s*(Done|In Progress|Error|Failed)/i.test(cell)) || "";
      const report = [...row.querySelectorAll("a")].find((link) => /processing report/i.test(link.textContent || ""));
      return { amazonBatchId: amazonBatchId.replace(/\s/g, ""), status, reportHref: report?.href || "" };
    }).filter((row) => row.amazonBatchId),
  });
  return result?.result || [];
}

async function refreshAmazonFeedHistory(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const refreshControl = [...document.querySelectorAll('button, input[type="button"], input[type="submit"]')]
        .find((element) => String(element.value || element.textContent || "").trim().toLowerCase() === "refresh");
      if (!refreshControl || refreshControl.disabled) return { clicked: false };
      refreshControl.click();
      return { clicked: true };
    },
  });
  if (result?.result?.clicked) {
    await waitForSellerCentralTabComplete(tabId);
    await delayMs(300);
  }
  return result?.result || { clicked: false };
}

async function readAmazonProcessingReport(tabId, reportHref) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [reportHref],
    func: async (href) => {
      const response = await fetch(new URL(href, location.href).href, { credentials: "include" });
      if (!response.ok) throw new Error(`Processing Report request failed: ${response.status}`);
      return await response.text();
    },
  });
  return String(result?.result || "");
}

async function getAmazonFeedWatches() {
  const stored = await chrome.storage.local.get([AMAZON_FEED_WATCHES_KEY]);
  return stored[AMAZON_FEED_WATCHES_KEY] && typeof stored[AMAZON_FEED_WATCHES_KEY] === "object"
    ? stored[AMAZON_FEED_WATCHES_KEY]
    : {};
}

async function saveAmazonFeedWatch(watch) {
  const watches = await getAmazonFeedWatches();
  watches[watch.batchId] = watch;
  await chrome.storage.local.set({ [AMAZON_FEED_WATCHES_KEY]: watches });
  chrome.alarms.create(AMAZON_FEED_WATCH_ALARM, { periodInMinutes: AMAZON_FEED_WATCH_PERIOD_MINUTES });
  return watch;
}

async function removeAmazonFeedWatch(batchId) {
  const watches = await getAmazonFeedWatches();
  delete watches[batchId];
  await chrome.storage.local.set({ [AMAZON_FEED_WATCHES_KEY]: watches });
  if (Object.keys(watches).length === 0) await chrome.alarms.clear(AMAZON_FEED_WATCH_ALARM);
}

async function reportAmazonFeedStatus(event) {
  if (!socket?.connected) return { ok: false, code: "SOCKET_OFFLINE" };
  const { shopId, clientId } = await getBaseShopAndIdentity();
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, code: "ACK_TIMEOUT" }), 10000);
    socket.emit("client:amazon_feed_status", {
      ...event,
      shopId,
      machineId: clientId,
      reportedAt: new Date().toISOString(),
    }, (ack) => {
      clearTimeout(timeout);
      resolve(ack || { ok: false, code: "EMPTY_ACK" });
    });
  });
}

async function reportAmazonFeedTaskTerminal(watch, status) {
  if (!socket?.connected || !watch.taskId) return;
  const { shopId, clientId } = await getBaseShopAndIdentity();
  socket.emit("client:task", {
    eventId: `${watch.taskId}:${status}`,
    taskId: watch.taskId,
    type: "UPLOAD_TRACKING",
    status: status === "done" ? "completed" : "failed",
    shopId,
    machineId: clientId,
    source: "amazon_extension",
    reportedAt: new Date().toISOString(),
    ...(status === "done" ? { result: { upload: { ok: true, batchId: watch.batchId, ordersCount: watch.expectedRows } } } : { error: `Amazon Processing Report finished with ${status}` }),
  });
}

async function pollAmazonFeedWatch(watch) {
  let tab = null;
  try {
    tab = watch.sellerCentralTabId ? await chrome.tabs.get(watch.sellerCentralTabId).catch(() => null) : null;
    if (!tab) tab = await findOrOpenSellerCentralFeedsTab({ dedicated: true, active: false });
    if (!tab?.id) return;
    await waitForSellerCentralTabComplete(tab.id);
    if (shouldRefreshAmazonFeedHistory(watch)) await refreshAmazonFeedHistory(tab.id);
    const rows = await readAmazonFeedHistory(tab.id);
    const row = watch.amazonBatchId
      ? rows.find((item) => String(item.amazonBatchId) === String(watch.amazonBatchId))
      : findNewAmazonFeedRow({ beforeBatchIds: watch.beforeBatchIds || [], rows });
    if (!row) return;

    const next = nextAmazonFeedWatchState({ ...watch, sellerCentralTabId: tab.id }, row);
    await saveAmazonFeedWatch(next);
    if (next.action === "poll") {
      await reportAmazonFeedStatus({ batchId: next.batchId, amazonBatchId: next.amazonBatchId, status: "processing" });
      return;
    }

    if (next.action === "fetch_report") {
      if (!row.reportHref) return;
      const reportText = await readAmazonProcessingReport(tab.id, row.reportHref);
      const ack = await reportAmazonFeedStatus(buildAmazonFeedDoneEvent({
        batchId: next.batchId,
        amazonBatchId: next.amazonBatchId,
        reportText,
      }));
      if (!ack?.ok || !ack?.terminal) return;
      await reportAmazonFeedTaskTerminal(next, ack.status);
      await removeAmazonFeedWatch(next.batchId);
      if (next.createdDedicatedTab) await chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }

    const ack = await reportAmazonFeedStatus({ batchId: next.batchId, amazonBatchId: next.amazonBatchId, status: "failed", failureReason: "Amazon feed history reports failure" });
    if (ack?.ok && ack?.terminal) {
      await reportAmazonFeedTaskTerminal(next, ack.status);
      await removeAmazonFeedWatch(next.batchId);
      if (next.createdDedicatedTab) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  } catch (error) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] Amazon feed watch poll failed", { batchId: watch.batchId, message: error?.message || String(error) }, "error");
  }
}

async function pollAmazonFeedWatches() {
  const watches = await getAmazonFeedWatches();
  await Promise.all(Object.values(watches).map((watch) => pollAmazonFeedWatch(watch)));
}

function sellerCentralTabUploadResultToResponse(result = {}) {
  const contentType = result.contentType || "";
  const textBody = result.textPreview || "";
  return {
    ok: !!result.ok,
    status: Number(result.status || 0),
    statusText: result.statusText || "",
    url: result.url || "",
    redirected: !!result.redirected,
    type: result.type || "",
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? contentType : "";
      },
      entries() {
        return contentType ? [["content-type", contentType]][Symbol.iterator]() : [][Symbol.iterator]();
      },
    },
    async json() {
      if (result.jsonParseOk) return result.json;
      return JSON.parse(textBody || "null");
    },
    async text() {
      return textBody;
    },
  };
}
async function amazonHeaders() {
  const a2z = await getCookie(`${SC_BASE}/`, "anti-csrftoken-a2z");
  const sessionToken = await getCookie(`${SC_BASE}/`, "session-token");

  const h = {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
    "origin": "https://sellercentral.amazon.com",
    "referer": `${SC_BASE}/order-reports-and-feeds/feeds`,
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
  };

  // Add CSRF token from anti-csrftoken-a2z cookie (not x-amz-csrf)
  if (a2z) h["anti-csrftoken-a2z"] = a2z;

  return h;
}

/* ---------- Fetch helpers ---------- */
function isJson(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json");
}
function isTsvish(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return (
    ct.includes("text/plain") ||
    ct.includes("text/tab-separated-values") ||
    ct.includes("octet-stream") ||
    ct.includes("text/xls")
  );
}
async function requestOnce(url, init = {}) {
  if (String(url || "").includes(AMAZON_UPLOADFEED_URL_PATH)) {
    const message = "uploadFeed must be called from Seller Central page context, not requestOnce/background fetch.";
    logUploadTrackingDiagnostic(
      "[UPLOAD_TRACKING] Blocked background uploadFeed request; use sellerCentralTabPageContext",
      { url: String(url || ""), method: init?.method || "GET" },
      "error"
    );
    throw createAmazonUploadError(
      "AMAZON_UPLOADFEED_BACKGROUND_FORBIDDEN",
      message,
      { url: String(url || ""), retryable: false }
    );
  }
  const headers = { ...(await amazonHeaders()), ...(init.headers || {}) };
  return fetch(url, {
    credentials: "include",
    redirect: "manual",
    ...init,
    headers,
  });
}

/* ---------- Storage / URLs ---------- */
async function getCfg(keys = []) {
  const all = await chrome.storage.local.get([
    "ingestUrl",
    "ingestToken",
    "shopId",
    "refNewOrders",
    "refAllOrders",
    // Ads headers (tự động cập nhật)
    "adsAccountId",
    "adsAdvertiserId",
    "adsClientId",
    "adsMarketplaceId",
    "adsCsrfData",
    "adsCsrfToken",
    "adsHeaderLastSeen",
    // Auto
    "autoEnabled",
    "autoUpload_enabled", "autoUpload_interval",
    ...keys,
  ]);
  return all;
}
function deriveApiUrls(ingestUrl) {
  const base =
    ingestUrl?.replace(/\/ext\/ingest(?:\/.*)?$/i, "") || ingestUrl || "";
  return {
    base,
    importNewUrl: `${base}/api/order/update-from-xlsx`,
    adsSpendUrl: `${base}/api/ads/import-day`,
    getSeller: `${base}/api/user/employee-code`,
    importFBMUrl: `${base}/api/shipping-batches`,
  };
}

function resolveCarrierInfo(tracking = "") {
  const normalized = String(tracking || "").trim().toUpperCase();

  if (normalized.startsWith("4PX")) {
    return { carrierCode: "4PX", shipMethod: "4PX-Global Express" };
  }

  if (normalized.startsWith("UK") || normalized.startsWith("UL")) {
    return { carrierCode: "Yanwen", shipMethod: "Yanwen Air Economy Mail General" };
  }
  if (normalized.startsWith("YT")) {
    return { carrierCode: "YunExpress", shipMethod: "YunExpress Global Direct line (standard)-Tracked" };
  }
  return { carrierCode: "USPS", shipMethod: "USPS First Class" };
}

const CONFIRM_SHIPMENT_TSV_EOL = "\r\n";

function joinConfirmShipmentTsvLines(lines = []) {
  return lines.map(line => String(line || "").replace(/\r?\n/g, "")).join(CONFIRM_SHIPMENT_TSV_EOL) + CONFIRM_SHIPMENT_TSV_EOL;
}

function auditTsvLineBreaks(tsvContent = "") {
  const text = String(tsvContent || "");
  const lines = text.split(/\r?\n/);
  return {
    hasCRLF: /\r\n/.test(text),
    crlfCount: (text.match(/\r\n/g) || []).length,
    lfCount: (text.match(/(?<!\r)\n/g) || []).length,
    lineCount: lines.filter(Boolean).length,
    headerLine: lines[0] || "",
    firstDataLine: lines[1] || "",
    headerEndsWithShipMethod: (lines[0] || "").endsWith("\tship-method") || (lines[0] || "").endsWith("ship-method"),
    headerDataConcatenated: /ship-method\d{3}-\d{7}-\d{7}/.test(text)
  };
}

function validateConfirmShipmentTsv(tsvContent = "") {
  const requiredHeaders = ["order-id", "ship-date", "carrier-code", "tracking-number", "ship-method"];
  const trimmedLines = String(tsvContent || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim());

  if (trimmedLines.length < 2) {
    throw createAmazonUploadError(
      "AMAZON_TSV_VALIDATION_FAILED",
      "Confirm shipment TSV must include a header row and at least one tracking row."
    );
  }

  const headers = trimmedLines[0].split("\t").map((header) => header.trim());
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length) {
    throw createAmazonUploadError(
      "AMAZON_TSV_VALIDATION_FAILED",
      `Confirm shipment TSV is missing required headers: ${missingHeaders.join(", ")}.`
    );
  }

  const indexByHeader = Object.fromEntries(headers.map((header, index) => [header, index]));
  const carrierBreakdown = {};
  const invalidRows = [];
  const normalizedShipDateRows = [];
  const shipDateNormalizationDetails = [];
  const marketplaceToday = formatDateYmdInTimeZone(new Date(), AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE);
  const shipDateIndex = indexByHeader["ship-date"];

  const normalizedRows = trimmedLines.slice(1).map((line, rowIndex) => {
    const cols = line.split("\t").map((col) => col.trim());
    const orderId = cols[indexByHeader["order-id"]] || "";
    const trackingNumber = cols[indexByHeader["tracking-number"]] || "";
    const carrierCode = cols[indexByHeader["carrier-code"]] || "UNKNOWN";
    const originalShipDate = cols[shipDateIndex] || "";
    const normalizedShipDate = originalShipDate;

    if (!orderId || !canSubmitAmazonRow({ tracking: trackingNumber, carrier: carrierCode, shipDate: normalizedShipDate })) {
      invalidRows.push(rowIndex + 2);
    }

    carrierBreakdown[carrierCode] = (carrierBreakdown[carrierCode] || 0) + 1;
    return headers.map((_, index) => cols[index] || "").join("\t");
  });

  if (invalidRows.length) {
    throw createAmazonUploadError(
      "AMAZON_TSV_VALIDATION_FAILED",
      `Confirm shipment TSV has missing tracking/carrier or a non-derived ship-date on row(s): ${invalidRows.slice(0, 20).join(", ")}.`
    );
  }

  extensionLogger?.logInfo("[UPLOAD_TRACKING] TSV validation passed", {
    rows: normalizedRows.length,
    carrierBreakdown,
    shipDateNormalizedRows: normalizedShipDateRows.length,
  });
  debugLog(`[UPLOAD_TRACKING] Carrier breakdown: ${JSON.stringify(carrierBreakdown)}`, "info");
  if (normalizedShipDateRows.length) {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] ship-date normalized for Amazon marketplace timezone", {
      rowsNormalized: normalizedShipDateRows.length,
      rowNumbers: normalizedShipDateRows.slice(0, 20).join(","),
      marketplaceTimeZone: AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE,
      marketplaceToday,
      examples: shipDateNormalizationDetails.slice(0, 5),
    });
  }

  const outputLines = [
    headers.join("\t"),
    ...normalizedRows
  ];

  return {
    content: joinConfirmShipmentTsvLines(outputLines),
    rows: normalizedRows.length,
    carrierBreakdown,
    shipDateNormalizedRows: normalizedShipDateRows,
    shipDateNormalizationDetails,
    shipDateFutureClampedRows: shipDateNormalizationDetails
      .filter((row) => row.clampedToMarketplaceToday)
      .map((row) => row.rowNumber),
    marketplaceToday,
    marketplaceTimeZone: AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE,
    lineEnding: "CRLF"
  };
}

async function uploadtracking(context = {}) {
  const startedAt = Date.now();

  if (!extensionLogger) await initializeLogger();

  const { ingestUrl, shopId, ingestToken } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  if (!shopId) throw new Error("Missing shopId (Options)");

  const { base } = deriveApiUrls(ingestUrl);
  const url = `${base}/api/shipping-batch/check-orders-status?machineId=${encodeURIComponent(shopId)}&limit=1000`;

  extensionLogger?.logInfo("[UPLOAD_TRACKING] Fetching order status from API", {
    shopId,
    url,
  });

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-access-token": ingestToken || "",
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const error = new Error(`uploadtracking API ${res.status}: ${errText.slice(0, 200)}`);
      extensionLogger?.logError(
        error,
        { shopId, url, status: res.status },
        "[UPLOAD_TRACKING] API request failed"
      );
      throw error;
    }

    const data = await res.json();
    const orders = data?.orders || [];

    // Lọc các đơn chưa submit lên Amazon
    const pendingOrders = orders.filter(
      (o) => o.submittedToAmazon === false && o.hasTracking === true
    );

    extensionLogger?.logInfo("[UPLOAD_TRACKING] pendingOrders", { pendingOrders });

    extensionLogger?.logInfo("[UPLOAD_TRACKING] check-orders-status fetched", {
      shopId,
      totalCount: data?.totalCount ?? orders.length,
      stats: data?.stats,
      pendingCount: pendingOrders.length,
      pendingOrders: pendingOrders.map((o) => ({
        orderId: o.orderId,
        tracking: o.tracking,
        status: o.status,
      })),
    });

    debugLog(
      `✅ [UPLOAD_TRACKING] Fetched ${orders.length} orders, ${pendingOrders.length} pending upload`,
      "success"
    );

    if (pendingOrders.length === 0) {
      debugLog("⏸️ [UPLOAD_TRACKING] No pending orders to upload", "info");
      extensionLogger?.logInfo("[UPLOAD_TRACKING] No pending orders to upload", { shopId });
      return { ...data, pendingOrders };
    }

    // Build TSV content
    const tsvLines = pendingOrders.map((o) => {
      const tracking = String(o.tracking || "").trim();
      const shipDate = String(o.shipDate || "").trim();
      const { carrierCode, shipMethod } = resolveCarrierInfo(tracking);

      return `${o.orderId}\t${shipDate}\t${carrierCode}\t${tracking}\t${shipMethod}`;
    });

    const rawTsvContent =
      joinConfirmShipmentTsvLines([
        "order-id\tship-date\tcarrier-code\ttracking-number\tship-method",
        ...tsvLines
      ]);
    const validatedTsv = validateConfirmShipmentTsv(rawTsvContent);
    const tsvContent = validatedTsv.content;

    const filename = `tracking-auto-${Date.now()}.txt`;
    const fileObj = new File(
      [new Blob([tsvContent], { type: "text/tab-separated-values; charset=utf-8" })],
      filename
    );

    debugLog(`📄 [UPLOAD_TRACKING] Built TSV: ${filename} (${pendingOrders.length} orders)`, "info");

    extensionLogger?.logInfo("[UPLOAD_TRACKING] TSV built, calling uploadToAmazon", {
      filename,
      ordersCount: pendingOrders.length,
      fileSize: tsvContent.length,
      carrierBreakdown: validatedTsv.carrierBreakdown,
    });

    await uploadToAmazon(fileObj, {
      batchId: `auto_${Date.now()}`,
      ordersCount: pendingOrders.length,
      carrierCode: "Mixed",
      shipMethod: "Mixed",
      shipDate: normalizeShipDateForAmazonConfirmShipment(new Date()),
    });

    const batchRes = await fetch(`${base}/api/shipping-batch/create-from-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-access-token": ingestToken || "",
      },
      body: JSON.stringify({
        machineId: shopId,
        orders: pendingOrders.map((o) => ({
          orderId: o.orderId,
          shopId: o.shopId,
        })),
        label: `Auto Upload - Shop ${shopId} - ${pendingOrders.length} orders`,
        autoUpload: true,
      }),
    });

    const batchData = await batchRes.json();

    if (!batchRes.ok) {

      const err = new Error(
        `create-from-orders ${batchRes.status}: ${JSON.stringify(batchData).slice(0, 200)}`
      );

      debugLog(`❌ [UPLOAD_TRACKING] create-from-orders failed: ${err.message}`, "error");

      extensionLogger?.logError(
        err,
        {
          shopId,
          status: batchRes.status,
          response: batchData,
        },
        "[UPLOAD_TRACKING] create-from-orders failed"
      );

      throw err;
    }

    debugLog(
      `✅ [UPLOAD_TRACKING] create-from-orders: ${JSON.stringify(batchData).slice(0, 200)}`,
      "success"
    );

    extensionLogger?.logTaskCompleted(
      {
        taskType: "UPLOAD_TRACKING",
        batchId: batchData?.batchId,
        ordersCount: pendingOrders.length,
      },
      {
        duration: Date.now(),
        response: batchData,
      },
      `[UPLOAD_TRACKING] create-from-orders success — ${pendingOrders.length} orders submitted`
    );

    return { ...data, pendingOrders };
  } catch (error) {
    debugLog(`❌ [UPLOAD_TRACKING] check-orders-status error: ${error.message}`, "error");
    extensionLogger?.logError(error, { shopId, url }, "[UPLOAD_TRACKING] check-orders-status failed");
    throw error;
  }
}
/* ---------- Identity ---------- */
// async function ensureIdentity() {
//   let { clientId, clientLabel } = await chrome.storage.local.get([
//     "clientId",
//     "clientLabel",
//   ]);
//   if (!clientId) {
//     clientId =
//       "cid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
//     await chrome.storage.local.set({ clientId });
//   }
//   clientLabel = "Machine-" + clientId.slice(-4);
//   await chrome.storage.local.set({ clientLabel });
//   return { clientId, clientLabel };
// }
async function ensureIdentity() {
  // Lấy shopId để làm clientId
  const { shopId } = await chrome.storage.local.get(["shopId"]);

  if (shopId) {
    // ✅ FIX: Sử dụng shopId làm clientId
    const clientId = shopId;
    const clientLabel = `Machine-${shopId.slice(-4)}`;

    // Lưu vào storage
    await chrome.storage.local.set({
      clientId: clientId,
      clientLabel: clientLabel
    });

    console.log('🔧 [FIX] Using shopId as clientId:', clientId);

    // Initialize logger if not already done
    if (!extensionLogger) {
      const { ingestUrl } = await getCfg();
      if (ingestUrl && shopId) {
        extensionLogger = new ExtensionLogger(
          clientId,
          shopId,
          clientLabel,
          ingestUrl
        );
        console.log('[EXT-LOG] Logger initialized:', { clientId, shopId, clientLabel, ingestUrl });
      }
    }

    return { clientId, clientLabel };
  }

  // Fallback nếu không có shopId
  let { clientId, clientLabel } = await chrome.storage.local.get([
    "clientId",
    "clientLabel"
  ]);

  if (!clientId) {
    clientId = "cid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await chrome.storage.local.set({ clientId });
  }

  clientLabel = "Machine-" + clientId.slice(-4);
  await chrome.storage.local.set({ clientLabel });

  // Initialize logger if not already done
  if (!extensionLogger) {
    const { ingestUrl, shopId: fallbackShopId } = await getCfg();
    if (ingestUrl && fallbackShopId) {
      extensionLogger = new ExtensionLogger(
        clientId,
        fallbackShopId,
        clientLabel,
        ingestUrl
      );
      console.log('[EXT-LOG] Logger initialized (fallback):', { clientId, shopId: fallbackShopId, clientLabel, ingestUrl });
    }
  }

  return { clientId, clientLabel };
}

/* ---------- Tiny TSV helper ---------- */
function parseTSV(tsv) {
  const clean = tsv.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows: [] };
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((l) => {
    const c = l.split("\t");
    const o = {};
    headers.forEach(
      (h, i) => (o[h.trim().toLowerCase()] = (c[i] ?? "").trim())
    );
    return o;
  });
  return { rows };
}

/* ===============================
   ORDERS: xin ref + kiểm tra + tải
   ============================== */
function buildNewOrdersPayload() {
  return {
    type: "newOrdersReport",
    reportVersion: "new",
    includeSalesChannel: false,
    // Rolling 7 days avoids missed orders from Amazon/Pacific timezone and report delay; backend must upsert/dedupe by order id.
    numDays: "7",
    numMonth: "0",
    numYear: "2015",
  };
}
function buildFBMOrdersPayload() {
  return {
    type: "fbmUnshippedOrdersReport",
    reportVersion: "new",
    includeSalesChannel: false,
    numDays: "1",
    numMonth: "0",
    numYear: "2015",
  };
}

async function requestReferenceIdNew(body) {
  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  // Log API request start
  if (extensionLogger) {
    await extensionLogger.logInfo('[AMAZON_API] Starting Amazon API request for reference ID', {
      endpoint: '/order-reports-and-feeds/api/reportRequest',
      requestBody: body,
      timestamp: new Date().toISOString()
    });
  }

  const url = `${SC_BASE}/order-reports-and-feeds/api/reportRequest`;
  const res = await requestOnce(url, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    const error = new Error(`reportRequest NEW ${res.status} — ${errorText.slice(0, 200)}`);

    if (extensionLogger) {
      await extensionLogger.logError(error, {
        url: url,
        status: res.status,
        statusText: res.statusText,
        requestBody: body,
        responseText: errorText.slice(0, 500)
      }, '[AMAZON_API] Amazon API request for reference ID failed');
    }
    throw error;
  }

  if (!isJson(res)) {
    const error = new Error(`reportRequest NEW non-JSON`);
    if (extensionLogger) {
      await extensionLogger.logError(error, {
        url: url,
        contentType: res.headers.get('content-type'),
        requestBody: body
      }, '[AMAZON_API] Amazon API returned non-JSON response');
    }
    throw error;
  }

  const j = await res.json();
  const referenceId = j?.referenceId || j?.data?.referenceId;

  // Log successful response
  if (extensionLogger) {
    await extensionLogger.logInfo('[AMAZON_API] Amazon API request successful', {
      referenceId: referenceId,
      status: res.status,
      responseKeys: Object.keys(j),
      timestamp: new Date().toISOString()
    });
  }

  return referenceId;
}

async function checkReportReady(referenceId) {
  const url = `${SC_BASE}/order-reports-and-feeds/api/documentMetadata?referenceId=${encodeURIComponent(
    referenceId
  )}`;
  const res = await requestOnce(url, { method: "GET" });

  if (res.status >= 300 && res.status < 400)
    return { ready: false, reason: "PENDING_REDIRECT" };

  if (isTsvish(res)) {
    const tsv = await res.text();
    const { rows } = parseTSV(tsv);
    if (rows.length > 0) return { ready: true, direct: true, tsv };
    return { ready: false, reason: "EMPTY_TSV" };
  }

  if (!isJson(res)) return { ready: false, reason: "PENDING_NON_JSON" };

  const j = await res.json().catch(() => ({}));
  const documentId = j?.data?.documentId;
  if (!documentId) return { ready: false, reason: "NO_DOCUMENT_ID_YET" };
  return { ready: true, documentId };
}

async function downloadByDocumentId(documentId) {
  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  // Log download start
  if (extensionLogger) {
    await extensionLogger.logInfo('[AMAZON_API] Starting Amazon file download', {
      documentId: documentId,
      endpoint: '/order-reports-and-feeds/feeds/download',
      timestamp: new Date().toISOString()
    });
  }

  const dlUrl = `${SC_BASE}/order-reports-and-feeds/feeds/download?documentId=${encodeURIComponent(
    documentId
  )}&fileType=txt`;

  const r = await requestOnce(dlUrl, { method: "GET" });

  if (!r.ok) {
    const error = new Error(`Amazon download ${r.status}`);
    if (extensionLogger) {
      await extensionLogger.logError(error, {
        documentId: documentId,
        url: dlUrl,
        status: r.status,
        statusText: r.statusText
      }, '[AMAZON_API] Amazon file download failed');
    }
    throw error;
  }

  const tsv = await r.text();
  const { rows } = parseTSV(tsv);

  // Log successful download
  if (extensionLogger) {
    await extensionLogger.logInfo('[AMAZON_API] Amazon file download successful', {
      documentId: documentId,
      fileSize: tsv.length,
      rowCount: rows.length,
      status: r.status,
      timestamp: new Date().toISOString()
    });
  }

  return { tsv, rows: rows.length, documentId };
}

/* ===============================
   Poll helper (10s x 5) + chống trùng ref
   =============================== */
const activeRefs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntilReady(
  referenceId,
  { intervalMs = 10000, maxAttempts = 5 } = {}
) {
  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  if (activeRefs.has(referenceId)) return activeRefs.get(referenceId);

  const job = (async () => {
    // Log polling start
    if (extensionLogger) {
      await extensionLogger.logInfo('[AMAZON_API] Starting Amazon report polling', {
        referenceId: referenceId,
        intervalMs: intervalMs,
        maxAttempts: maxAttempts,
        timestamp: new Date().toISOString()
      });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Log each polling attempt
      if (extensionLogger) {
        await extensionLogger.logInfo(`[AMAZON_API] Amazon report polling attempt ${attempt}/${maxAttempts}`, {
          referenceId: referenceId,
          attempt: attempt,
          maxAttempts: maxAttempts,
          timestamp: new Date().toISOString()
        });
      }

      const st = await checkReportReady(referenceId);

      if (st.ready) {
        activeRefs.delete(referenceId);

        // Log successful completion
        if (extensionLogger) {
          await extensionLogger.logInfo('[IMPORT_ODER] import oder done', {
            referenceId: referenceId,
            attempt: attempt,
            isDirect: st.direct,
            documentId: st.documentId,
            timestamp: new Date().toISOString()
          });
        }

        if (st.direct) return { direct: true, tsv: st.tsv };
        return { documentId: st.documentId };
      }

      if (attempt < maxAttempts) {
        // Log waiting between attempts
        if (extensionLogger) {
          await extensionLogger.logInfo(`[AMAZON_API] Amazon report not ready, waiting ${intervalMs}ms`, {
            referenceId: referenceId,
            attempt: attempt,
            waitTime: intervalMs,
            timestamp: new Date().toISOString()
          });
        }
        await sleep(intervalMs);
      }
    }

    activeRefs.delete(referenceId);
    const error = new Error(
      `Report ${referenceId} not ready after ${(intervalMs * maxAttempts) / 1000}s`
    );

    // Log polling timeout
    if (extensionLogger) {
      await extensionLogger.logError(error, {
        referenceId: referenceId,
        maxAttempts: maxAttempts,
        totalWaitTime: (intervalMs * maxAttempts) / 1000,
        timestamp: new Date().toISOString()
      }, '[AMAZON_API] Amazon report polling timeout');
    }

    throw error;
  })();

  activeRefs.set(referenceId, job);
  return job;
}

/* ===============================
   Push file về backend (REST import/report/ads)
   =============================== */
async function postFileTo(url, fields) {
  const { ingestToken } = await getCfg();
  const fd = new FormData();

  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "file" || k === "filename") continue;
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }
  if (typeof fields.file === "string") {
    const name = fields.filename || "file.txt";
    fd.append("file", new Blob([fields.file], { type: "text/plain" }), name);
  } else if (fields.file && typeof fields.file.text === "string") {
    const name = fields.file.name || "file.txt";
    fd.append(
      "file",
      new Blob([fields.file.text], { type: "text/plain" }),
      name
    );
  } else {
    throw new Error("postFileTo: file missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "x-access-token": ingestToken || "" },
    body: fd,
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json")
    ? res.json()
    : { ok: true, raw: await res.text() };
}

async function runImportNewOrders(referenceOverride) {
  const { ingestUrl, shopId, ingestToken } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importNewUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    const newOrdersPayload = buildNewOrdersPayload();
    console.log("[IMPORT_ORDERS] Requesting New Orders report with rolling window: 7 days");
    extensionLogger?.logInfo("[IMPORT_ORDERS] Requesting New Orders report with rolling window: 7 days", {
      numDays: newOrdersPayload.numDays,
    });

    try {
      referenceId = await requestReferenceIdNew(newOrdersPayload);
    } catch (error) {
      extensionLogger?.logError(
        error,
        {
          function: "runImportNewOrders",
          stage: "requestReferenceIdNew",
          numDays: newOrdersPayload.numDays,
          fallbackDisabled: true,
        },
        "[IMPORT_ORDERS] Failed to request fresh New Orders report; fallback refNewOrders disabled"
      );
      throw error;
    }
  }
  if (!referenceId) throw new Error("No referenceId found for NEW orders.");

  const st = await pollUntilReady(referenceId, {
    intervalMs: 10000,
    maxAttempts: 5,
  });

  let tsv,
    documentId = null,
    rows = 0;
  if (st.direct) {
    tsv = st.tsv;
    rows = parseTSV(tsv).rows.length;
  } else {
    const r = await downloadByDocumentId(st.documentId);
    tsv = r.tsv;
    documentId = r.documentId;
    rows = r.rows;
  }

  const fd = new FormData();
  if (shopId) fd.append("shopId", shopId);
  fd.append(
    "file",
    new Blob([tsv], { type: "text/plain" }),
    `orders-new-${referenceId}.txt`
  );
  fd.append("type", "New");

  let importNewOrigin = "";
  let hasImportNewHostPermission = null;
  try {
    importNewOrigin = new URL(importNewUrl).origin;
    if (chrome?.permissions?.contains) {
      hasImportNewHostPermission = await chrome.permissions.contains({
        origins: [`${importNewOrigin}/*`],
      });
    }
  } catch (_) { }

  let resp;
  try {
    resp = await fetch(importNewUrl, {
      method: "POST",
      headers: { "x-access-token": ingestToken || "" },
      body: fd,
    });
  } catch (error) {
    const hint = importNewOrigin
      ? ` Check API Base URL, backend availability, HTTPS certificate, and manifest host_permissions for ${importNewOrigin}/*`
      : " Check API Base URL and backend availability.";
    const wrapped = new Error(
      `[IMPORT_ORDERS] Backend upload failed before HTTP response: ${error?.message || error}.${hint}`
    );
    wrapped.cause = error;
    extensionLogger?.logError(
      error,
      {
        function: "runImportNewOrders",
        stage: "backendUploadFetch",
        ingestUrl,
        importNewUrl,
        importNewOrigin,
        hasImportNewHostPermission,
        shopId,
        hasIngestToken: !!ingestToken,
      },
      "[IMPORT_ORDERS] Backend upload fetch failed before HTTP response"
    );
    throw wrapped;
  }
  const responseText = await resp.text();
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = { raw: responseText };
  }

  if (!resp.ok) {
    const backendMessage = responseBody?.error || responseBody?.message || responseText;
    throw new Error(`Backend ${resp.status}${backendMessage ? `: ${backendMessage}` : ""}`);
  }

  const ingest = responseBody || { ok: true, raw: responseText };
  return { ok: true, rows, documentId, referenceId, ingest };
}

// Confirm Shipping
async function runImportFBMOrders(referenceOverride, machineId, label) {
  const { ingestUrl, ingestToken, refNewOrders } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importFBMUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    try {
      referenceId = await requestReferenceIdNew(buildFBMOrdersPayload());
    } catch (e) {
      referenceId = refNewOrders;
    }
  }
  if (!referenceId) throw new Error("No referenceId found for FBM orders.");

  const st = await pollUntilReady(referenceId, {
    intervalMs: 10000,
    maxAttempts: 5,
  });

  let tsv,
    documentId = null,
    rows = 0;
  if (st.direct) {
    tsv = st.tsv;
    rows = parseTSV(tsv).rows.length;
  } else {
    const r = await downloadByDocumentId(st.documentId);
    tsv = r.tsv;
    documentId = r.documentId;
    rows = r.rows;
  }

  const fd = new FormData();
  fd.append(
    "file",
    new Blob([tsv], { type: "text/plain" }),
    `orders-FBM-${referenceId}.txt`
  );
  fd.append("machineId", machineId);
  fd.append("label", label);

  const resp = await fetch(importFBMUrl, {
    method: "POST",
    headers: { "x-access-token": ingestToken || "" },
    body: fd,
  });
  if (!resp.ok) throw new Error(`Backend ${resp.status}`);
  const ingest = (resp.headers.get("content-type") || "")
    .toLowerCase()
    .includes("application/json")
    ? await resp.json()
    : { ok: true, raw: await resp.text() };

  return { ok: true, rows, documentId, referenceId, ingest };
}

/* ===============================
   ADS via content-script
   =============================== */
function adsTabAccessError(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.origin === ADS_BASE) return "";
    return `Amazon Ads đã chuyển tab sang ${parsed.origin}. Hãy đăng nhập lại Amazon Ads rồi mở ${ADS_CAMPAIGNS_URL}.`;
  } catch (_) {
    return "Không xác định được URL tab Amazon Ads.";
  }
}

async function persistManualAdsResult(kind, range, result) {
  await chrome.storage.local.set({
    [ADS_LAST_RESULT_STORAGE_KEY]: {
      kind,
      range,
      result,
      completedAt: Date.now(),
    },
  });
}

async function assertAdsTabAccessible(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const accessError = adsTabAccessError(tab?.url);
  if (accessError) throw new Error(accessError);
  return tab;
}

async function ensureAdsTab({ active = false } = {}) {
  const tabs = await chrome.tabs.query({ url: `${ADS_BASE}/*` });
  let tab = tabs.find((t) => t.url?.includes("/campaign-manager/all-campaigns")) || tabs.find((t) => t.url?.includes("/cm/")) || tabs[0];
  const created = !tab;

  if (!tab) {
    debugLog("🌐 [ADS-TAB] Opening Amazon Ads campaigns page...", "info");
    extensionLogger?.logInfo("[ADS-TAB] Opening Amazon Ads campaigns page");
    tab = await chrome.tabs.create({
      url: ADS_CAMPAIGNS_URL,
      active,
    });
  }

  await waitForAdsTabComplete(tab.id);
  const readyTab = await assertAdsTabAccessible(tab.id);
  if (active) {
    await chrome.windows.update(readyTab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    debugLog(`🌐 [ADS-TAB] Showing Ads tab ${tab.id}: ${readyTab.url}`, "info");
  }
  return { tabId: tab.id, created };
}

async function withForegroundAdsTab(fn) {
  const tab = await ensureAdsTab({ active: true });
  // Keep the visible Campaigns UI long enough for Amazon to finish its own
  // charts/table requests before the report request is made.
  await delayMs(ADS_PAGE_SETTLE_MS);
  try {
    const result = await fn();
    if (tab.created) await chrome.tabs.remove(tab.tabId).catch(() => {});
    return result;
  } catch (error) {
    // Keep a failed, auto-created tab visible so the user can resolve login/CSRF.
    throw error;
  }
}

async function withAutoCreatedAdsTab(fn) {
  const tab = await ensureAdsTab();
  try {
    const result = await fn();
    if (shouldCloseAutoCreatedAdsTab({ created: tab.created, completed: true })) {
      await chrome.tabs.remove(tab.tabId).catch(() => {});
    }
    return result;
  } catch (error) {
    // Keep a failed, auto-created tab available for login/CSRF recovery.
    throw error;
  }
}

async function injectAdsMainWorldSniffer(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const ADS_HOST = "advertising.amazon.com";
        const MSG_TYPE = "APO_ADS_HEADER_SNIFF";
        if (window.__APO_ADS_MAIN_WORLD_SNIFFER__) return;
        window.__APO_ADS_MAIN_WORLD_SNIFFER__ = true;

        const MAP = {
          "amazon-ads-account-id": "adsAccountId",
          "amazon-advertising-api-advertiserid": "adsAdvertiserId",
          "amazon-advertising-api-clientid": "adsClientId",
          "amazon-advertising-api-marketplaceid": "adsMarketplaceId",
          "amazon-advertising-api-csrf-data": "adsCsrfData",
          "amazon-advertising-api-csrf-token": "adsCsrfToken",
        };

        function normalizeHeaders(headers) {
          const out = {};
          if (!headers) return out;
          try {
            if (headers instanceof Headers) {
              headers.forEach((v, k) => (out[String(k).toLowerCase()] = String(v)));
            } else if (Array.isArray(headers)) {
              headers.forEach(([k, v]) => (out[String(k).toLowerCase()] = String(v)));
            } else {
              Object.entries(headers).forEach(([k, v]) => (out[String(k).toLowerCase()] = String(v)));
            }
          } catch (_) { }
          return out;
        }

        function shouldCapture(url) {
          try {
            return new URL(url, location.href).host.endsWith(ADS_HOST);
          } catch (_) {
            return false;
          }
        }

        function extract(headers) {
          const src = normalizeHeaders(headers);
          const out = {};
          for (const [k, storageKey] of Object.entries(MAP)) {
            if (src[k]) out[storageKey] = src[k];
          }
          return out;
        }

        function publish(headers) {
          const data = extract(headers);
          if (!Object.keys(data).length) return;
          window.postMessage({ __apo: true, type: MSG_TYPE, data }, "*");
        }

        const nativeFetch = window.fetch;
        window.fetch = function patchedFetch(input, init = {}) {
          try {
            const url = typeof input === "string" ? input : input?.url;
            if (url && shouldCapture(url)) {
              const merged = {
                ...normalizeHeaders(input?.headers),
                ...normalizeHeaders(init?.headers),
              };
              publish(merged);
            }
          } catch (_) { }
          return nativeFetch.apply(this, arguments);
        };

        const nativeOpen = XMLHttpRequest.prototype.open;
        const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        const nativeSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
          this.__apoAdsUrl = url;
          this.__apoAdsHeaders = {};
          return nativeOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
          try {
            this.__apoAdsHeaders[String(name).toLowerCase()] = String(value);
          } catch (_) { }
          return nativeSetRequestHeader.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function patchedSend() {
          try {
            if (this.__apoAdsUrl && shouldCapture(this.__apoAdsUrl)) {
              publish(this.__apoAdsHeaders || {});
            }
          } catch (_) { }
          return nativeSend.apply(this, arguments);
        };
      },
    });
    return true;
  } catch (e) {
    debugLog(`⚠️ [ADS-SNIFFER] Main-world injection skipped: ${e?.message || e}`, "info");
    return false;
  }
}

async function ensureAdsBridgeInjected(tabId) {
  const tab = await assertAdsTabAccessible(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ads_bridge.js"],
    });
  } catch (e) {
    if (/Cannot access contents of the page/i.test(e?.message || "")) {
      throw new Error(`Extension không có quyền truy cập ${tab.url}. Reload Extension tại chrome://extensions rồi refresh trang Amazon Ads.`);
    }
    // Nếu content script đã tồn tại hoặc tab chưa cho inject, sendMessage phía dưới sẽ xác nhận lại.
    debugLog(`ℹ️ [ADS-BRIDGE] executeScript note: ${e?.message || e}`, "info");
  }
  await injectAdsMainWorldSniffer(tabId);
}

async function adsRetrieveViaContentScript(payload, options = {}) {
  const { tabId } = await ensureAdsTab();
  await ensureAdsBridgeInjected(tabId);

  const sendOnce = () =>
    chrome.tabs.sendMessage(tabId, {
      type: "ADS_FETCH_REPORT",
      url: ADS_RETRIEVE_URL,
      payload,
      options,
    });

  let lastError = null;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await sendOnce();
      if (r) return r;
    } catch (e) {
      lastError = e;
      if (i === 1) await ensureAdsBridgeInjected(tabId);
      await delayMs(400 + i * 300);
    }
  }

  throw new Error(`Could not establish connection to ads_bridge.js${lastError?.message ? `: ${lastError.message}` : ""}`);
}

async function fetchAdsJsonCS(payload, options = {}) {
  if (!extensionLogger) await initializeLogger();

  const maxAttempts = Number(options.maxAttempts || 2);
  let lastError = null;
  const reportConfig = payload?.reportConfig || {};
  const pagination = reportConfig?.offsetPagination || {};
  const requestMeta = {
    startDate: reportConfig.startDate,
    endDate: reportConfig.endDate,
    offset: pagination.offset,
    size: pagination.size,
    isCheckCampain: !!options.isCheckCampain,
    runId: options.runId,
    lockOwner: !!options.lockOwner,
    taskName: options.taskName,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        debugLog(`🔁 [ADS-AUTH] Retrying retrieveReport after auth refresh (${attempt}/${maxAttempts})`, "info");
        // Headers were refreshed by the lock owner before this retry.
      }

      extensionLogger?.logInfo("[IMPORT_ADS_SPEND] Making Amazon Ads API call via content script", {
        attempt,
        maxAttempts,
        payloadKeys: Object.keys(payload || {}),
        ...requestMeta,
        timestamp: new Date().toISOString(),
      });

      const r = await adsRetrieveViaContentScript(payload, { ...options, ...requestMeta, attempt, maxAttempts });
      if (!r) throw createAdsError("retrieveReport no response", 0, "");

      const sample = typeof r.text === "string" ? r.text : JSON.stringify(r.text || "");
      extensionLogger?.logInfo("[IMPORT_ADS_SPEND] Amazon Ads API HTTP response", {
        ...requestMeta,
        attempt,
        status: r.status,
        ok: r.ok,
      });

      if (!r.ok) {
        const error = createAdsError(`retrieveReport ${r.status} — ${sample.slice(0, 200)}`, r.status, sample);
        extensionLogger?.logError(error, {
          status: r.status,
          attempt,
          ...requestMeta,
          responseText: sample.slice(0, 500),
          payload,
          endpoint: "Amazon Ads API",
        }, "[IMPORT_ADS_SPEND] Amazon Ads API request failed");

        if (isAdsAuthError(error) && attempt < maxAttempts) {
          if (!isAdsLockOwner(options.runId)) {
            const ownerError = createAdsError("ADS_LOCK_NOT_OWNER: cannot refresh Ads headers while another Ads task owns the lock", r.status, sample);
            ownerError.code = "ADS_LOCK_NOT_OWNER";
            throw ownerError;
          }
          await clearAdsHeaders(`retrieveReport-${r.status}`, options);
          await forceRefreshAdsHeaders({ ...options, reason: `retrieveReport-${r.status}` });
          lastError = error;
          continue;
        }
        throw error;
      }

      try {
        const j = JSON.parse(r.text || "{}");
        const report = j?.report || j?.data?.report || {};
        extensionLogger?.logInfo("[IMPORT_ADS_SPEND] Amazon Ads API response received", {
          status: r.status,
          attempt,
          ...requestMeta,
          responseSize: r.text?.length || 0,
          numberOfRecords: report?.numberOfRecords || 0,
          dataRows: Array.isArray(report?.data) ? report.data.length : 0,
          hasReport: !!report,
          timestamp: new Date().toISOString(),
        });
        return j;
      } catch (parseError) {
        const error = createAdsError(`retrieveReport non-JSON: ${sample.slice(0, 200)}`, r.status || 0, sample);
        error.parseError = parseError.message;
        extensionLogger?.logError(error, {
          attempt,
          ...requestMeta,
          responseText: sample.slice(0, 500),
          parseError: parseError.message,
          payload,
          endpoint: "Amazon Ads API",
        }, "[IMPORT_ADS_SPEND] Amazon Ads API returned non-JSON response");

        if (isAdsAuthError(error) && attempt < maxAttempts) {
          if (!isAdsLockOwner(options.runId)) {
            const ownerError = createAdsError("ADS_LOCK_NOT_OWNER: cannot refresh Ads headers while another Ads task owns the lock", r.status || 0, sample);
            ownerError.code = "ADS_LOCK_NOT_OWNER";
            throw ownerError;
          }
          await clearAdsHeaders("retrieveReport-non-json-auth-page", options);
          await forceRefreshAdsHeaders({ ...options, reason: "retrieveReport-non-json-auth-page" });
          lastError = error;
          continue;
        }
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (!error?.adsRefreshFailed && isAdsAuthError(error) && attempt < maxAttempts) {
        if (!isAdsLockOwner(options.runId)) {
          const ownerError = createAdsError("ADS_LOCK_NOT_OWNER: cannot refresh Ads headers while another Ads task owns the lock", error.status || 0, error.responseText || error.message || "");
          ownerError.code = "ADS_LOCK_NOT_OWNER";
          throw ownerError;
        }
        await clearAdsHeaders(`catch-${error.status || error.code || "auth"}`, options);
        await forceRefreshAdsHeaders({ ...options, reason: `catch-${error.status || error.code || "auth"}` });
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("retrieveReport failed after auth retry");
}

function buildCampaignSpendPayload({
  startDate,
  endDate,
  size,
  offset,
  timeUnit = "DAILY",
  isCheckCampain = false,
}) {
  const valueFilter = isCheckCampain
    ? ["ENABLED", "PAUSED"]
    : ["ENABLED", "PAUSED", "ARCHIVED"];
  return {
    reportConfig: {
      reportId: "CrossProgramCampaignReport",
      currencyOfView: "USD",
      endDate,
      fields: ["campaignName", "spend", "state"],
      filter: {
        and: [
          {
            comparisonOperator: "IN",
            field: "state",
            not: false,
            values: valueFilter,
          },
        ],
      },
      offsetPagination: { size, offset },
      startDate,
      timeUnits: [timeUnit],
    },
  };
}

async function fetchAllCampaignSpend(
  startDate,
  endDate,
  pageSize = 300,
  isCheckCampain = false,
  options = {}
) {
  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  // Log Amazon Ads API request start
  if (extensionLogger) {
    await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Starting Amazon Ads API request', {
      startDate: startDate,
      endDate: endDate,
      pageSize: pageSize,
      isCheckCampain: isCheckCampain,
      endpoint: 'Amazon Ads Campaign Spend API',
      timestamp: new Date().toISOString()
    });
  }

  try {
    const firstJson = await fetchAdsJsonCS(
      buildCampaignSpendPayload({
        startDate,
        endDate,
        size: Math.max(1, Math.min(pageSize, 300)),
        offset: 0,
        isCheckCampain,
      }),
      { ...options, isCheckCampain, pageOffset: 0, pageSize: Math.max(1, Math.min(pageSize, 300)) }
    );

    const report0 = firstJson?.report || firstJson?.data?.report || {};
    const count = report0?.numberOfRecords ?? 0;
    const rows1 = Array.isArray(report0?.data) ? report0.data : [];

    // Log first page results
    if (extensionLogger) {
      await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Amazon Ads API first page response', {
        totalRecords: count,
        firstPageRows: rows1.length,
        startDate: startDate,
        endDate: endDate,
        timestamp: new Date().toISOString()
      });
    }

    if (count === 0 || rows1.length === 0) {
      // Log no data found
      if (extensionLogger) {
        await extensionLogger.logInfo('[IMPORT_ADS_SPEND] No campaign spend data found', {
          startDate: startDate,
          endDate: endDate,
          totalRecords: count,
          timestamp: new Date().toISOString()
        });
      }
      return [];
    }

    const totalPages = Math.ceil(count / pageSize);
    let all = rows1;

    // Log pagination info
    if (extensionLogger && totalPages > 1) {
      await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Fetching additional pages from Amazon Ads API', {
        totalPages: totalPages,
        totalRecords: count,
        pageSize: pageSize,
        startDate: startDate,
        endDate: endDate,
        timestamp: new Date().toISOString()
      });
    }

    for (let page = 1; page < totalPages; page++) {
      const js = await fetchAdsJsonCS(
        buildCampaignSpendPayload({
          startDate,
          endDate,
          size: pageSize,
          offset: page * pageSize,
          isCheckCampain,
        }),
        { ...options, isCheckCampain, pageOffset: page * pageSize, pageSize }
      );
      const report = js?.report || js?.data?.report || {};
      const more = Array.isArray(report?.data) ? report.data : [];

      // Log each page fetch
      if (extensionLogger) {
        await extensionLogger.logInfo(`[IMPORT_ADS_SPEND] Amazon Ads API page ${page + 1}/${totalPages} response`, {
          pageRows: more.length,
          totalFetched: all.length + more.length,
          totalRecords: count,
          timestamp: new Date().toISOString()
        });
      }

      if (!more.length) break;
      all = all.concat(more);
      await delayMs(200);
    }

    const processedData = all.map((r) => ({
      campaignName: r.campaignName ?? "",
      date: startDate,
      spend: Number(r.spend ?? 0),
      state: r.state ?? "",
    }));

    // Log successful completion
    if (extensionLogger) {
      await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Amazon Ads API data fetch completed', {
        totalCampaigns: processedData.length,
        totalSpend: processedData.reduce((sum, r) => sum + r.spend, 0),
        startDate: startDate,
        endDate: endDate,
        pagesProcessed: totalPages,
        timestamp: new Date().toISOString()
      });
    }

    return processedData;

  } catch (error) {
    // Log Amazon Ads API error
    if (extensionLogger) {
      await extensionLogger.logError(error, {
        startDate: startDate,
        endDate: endDate,
        pageSize: pageSize,
        isCheckCampain: isCheckCampain,
        endpoint: 'Amazon Ads Campaign Spend API'
      }, '[IMPORT_ADS_SPEND] Amazon Ads API request failed');
    }
    throw error;
  }
}

function campaignRowsToTxt(rows) {
  const header = "Campaigns\tDate\tSpend";
  const lines = rows.map((r) =>
    [
      String(r.campaignName).replace(/\t/g, " ").replace(/\r?\n/g, " "),
      r.date,
      r.spend,
    ].join("\t")
  );
  return [header, ...lines].join("\n");
}

const MAX_ADS_RANGE_DAYS = 31;

function adsDaysBetween(startDate, endDate = startDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "")) {
    throw new Error("startDate and endDate must use YYYY-MM-DD");
  }
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ||
    start.toISOString().slice(0, 10) !== startDate ||
    end.toISOString().slice(0, 10) !== endDate ||
    start > end
  ) {
    throw new Error("Khoảng ngày Ads không hợp lệ");
  }

  const days = [];
  for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
    if (days.length > MAX_ADS_RANGE_DAYS) {
      throw new Error(`Chỉ cho phép tối đa ${MAX_ADS_RANGE_DAYS} ngày mỗi lần`);
    }
  }
  return days;
}

function summarizeAdsRows(rows, startDate, endDate) {
  const byCampaignName = new Map();
  const byState = new Map();

  for (const row of rows) {
    const name = String(row.campaignName || "").trim() || "(unnamed)";
    const spend = Number(row.spend || 0);
    const state = String(row.state || "UNKNOWN");
    const campaign = byCampaignName.get(name) || { campaignName: name, spend: 0, records: 0, states: new Set() };
    campaign.spend += spend;
    campaign.records += 1;
    campaign.states.add(state);
    byCampaignName.set(name, campaign);

    const stateSummary = byState.get(state) || { records: 0, spend: 0 };
    stateSummary.records += 1;
    stateSummary.spend += spend;
    byState.set(state, stateSummary);
  }

  const nonZeroRows = rows.filter((row) => Number(row.spend || 0) > 0);
  return {
    ok: true,
    startDate,
    endDate,
    rawRecords: rows.length,
    uniqueCampaignNames: byCampaignName.size,
    recordsWithSpend: nonZeroRows.length,
    totalSpend: Number(rows.reduce((total, row) => total + Number(row.spend || 0), 0).toFixed(2)),
    byState: Object.fromEntries([...byState.entries()].map(([state, value]) => [state, { ...value, spend: Number(value.spend.toFixed(2)) }])),
    topCampaigns: [...byCampaignName.values()]
      .map((campaign) => ({ ...campaign, spend: Number(campaign.spend.toFixed(2)), states: [...campaign.states] }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 20),
  };
}

// Full, read-only inspection for a human before enabling scheduled imports.
async function previewAdsSpend(date) {
  return previewAdsSpendRange(date, date);
}

async function previewAdsSpendRange(startDate, endDate = startDate) {
  const days = adsDaysBetween(startDate, endDate);
  return withAdsApiLock("PREVIEW_ADS_SPEND", async (lock) => {
    return withForegroundAdsTab(async () => {
      await ensureFreshAdsHeaders({ ...lock, reason: "previewAdsSpend" });
      const rows = [];
      for (const day of days) {
        rows.push(...await fetchAllCampaignSpend(day, day, 300, false, lock));
      }
      return { ...summarizeAdsRows(rows, startDate, endDate), days: days.length };
    });
  });
}

async function runExportAdsSpend(date, options = {}) {
  return runExportAdsSpendRange(date, date, options);
}

function adsTaskSummary(result) {
  return {
    startDate: result?.startDate || "",
    endDate: result?.endDate || "",
    days: (result?.days || []).map((item) => ({
      day: String(item?.ingest?.day || "").slice(0, 10),
      importedRows: Number(item?.ingest?.importedRows ?? item?.rows ?? 0),
      sellersAffected: Number(item?.ingest?.sellersAffected || 0),
      shopSpend: Number(item?.ingest?.shopSpend || 0),
      skipped: item?.ingest?.skipped === true,
      message: String(item?.ingest?.message || "").slice(0, 240),
    })),
  };
}

async function runExportAdsSpendRange(startDate, endDate = startDate, options = {}) {
  const days = adsDaysBetween(startDate, endDate);
  return withAdsApiLock("IMPORT_ADS_SPEND", async (lock) => {
    const run = async () => {
      await ensureFreshAdsHeaders({ ...lock, reason: "runExportAdsSpendRange" });
      const results = [];
      for (const day of days) {
        results.push(await runExportAdsSpendLocked(day, lock, { ...options, headersReady: true }));
      }
      return {
        ok: true,
        dryRun: options.dryRun === true,
        startDate,
        endDate,
        days: results,
        totalRows: results.reduce((total, result) => total + Number(result.rows || 0), 0),
      };
    };
    return options.foreground ? withForegroundAdsTab(run) : withAutoCreatedAdsTab(run);
  });
}

async function runExportAdsSpendLocked(date, lock = {}, options = {}) {
  const startTime = Date.now();

  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  // Log task processing start
  if (extensionLogger) {
    await extensionLogger.logTaskProcessing({
      taskId: `ads_export_${Date.now()}`,
      taskType: 'IMPORT_ADS_SPEND',
      batchId: `ads_${date}`,
      ordersCount: 0,
      filename: `ads-spend-${date}.txt`
    }, `[IMPORT_ADS_SPEND] Starting ads spend export for date: ${date}`);
  }

  const { ingestUrl, shopId } = await getCfg();
  if (!ingestUrl) {
    const error = new Error("Missing ingestUrl (Options)");
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${date}`
      }, error, '[IMPORT_ADS_SPEND] Ads export failed: Missing ingestUrl');
    }
    throw error;
  }

  const { adsSpendUrl } = deriveApiUrls(ingestUrl);

  // Đảm bảo Ads headers còn hạn trước khi gọi Ads API
  if (!options.headersReady) {
    await ensureFreshAdsHeaders({ ...lock, reason: "runExportAdsSpend" });
  }

  if (!date) {
    const error = new Error("date (YYYY-MM-DD) required");
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${date}`
      }, error, '[IMPORT_ADS_SPEND] Ads export failed: Missing date parameter');
    }
    throw error;
  }
  try {
    // Log fetching campaign data
    if (extensionLogger) {
      await extensionLogger.logInfo('Lấy dữ liệu chi phí campaign từ Amazon', {
        date: date,
        endpoint: 'Amazon Ads API',
        timestamp: new Date().toISOString()
      });
    }

    const rows = await fetchAllCampaignSpend(date, date, 300, false, lock);

    // Log data processing
    if (extensionLogger) {
      await extensionLogger.logInfo('Xử lý dữ liệu chi phí campaign', {
        rowCount: rows.length,
        date: date,
        timestamp: new Date().toISOString()
      });
    }

    const txt = campaignRowsToTxt(rows);

    // Log uploading to backend
    if (extensionLogger) {
      await extensionLogger.logInfo('Upload dữ liệu chi phí quảng cáo lên backend', {
        url: adsSpendUrl,
        fileSize: txt.length,
        rowCount: rows.length,
        filename: `ads-spend-${date}.txt`,
        timestamp: new Date().toISOString()
      });
    }

    const ingestRes = await postFileTo(adsSpendUrl, {
      shopId,
      day: date,
      dryRun: options.dryRun === true,
      file: { name: `ads-spend-${date}.txt`, text: txt },
    });

    const endTime = Date.now();

    // Log task completed
    if (extensionLogger) {
      await extensionLogger.logTaskCompleted({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${date}`,
        ordersCount: rows.length,
        filename: `ads-spend-${date}.txt`
      }, {
        duration: endTime - startTime,
        memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
        cpuUsage: 0
      }, `Xuất chi phí quảng cáo hoàn thành thành công cho ${date}`);
    }

    return { ok: true, dryRun: options.dryRun === true, rows: rows.length, ingest: ingestRes };

  } catch (error) {
    // Log task failed
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${date}`,
        ordersCount: 0,
        filename: `ads-spend-${date}.txt`
      }, error, `Xuất chi phí quảng cáo thất bại cho ${date}`);
    }
    throw error;
  }
}

/* ===============================
   UPLOAD TRACKING - Upload file TXT lên Amazon
   =============================== */

function computeUploadTrackingChecksum(text = "") {
  let hash = 5381;
  const str = String(text || "");
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function uploadToAmazon(fileObj, uploadParams = {}) {
  const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();
  const startTime = Date.now();
  const uploadTaskId = uploadParams?.taskId || uploadParams?.batchId || `upload_${startTime}`;
  const uploadBatchId = uploadParams?.batchId || uploadTaskId;
  let stableFileObj = fileObj;
  let finalTsvHeader = "";
  let finalTsvFirstDataLine = "";
  let finalTsvLineCount = 0;
  let finalTsvChecksum = "";
  let finalTsvLength = 0;
  let preflight = null;
  let pageUploadResult = null;
  let dedicatedSellerCentralTab = null;
  let historyBeforeBatchIds = [];

  if (!extensionLogger) await initializeLogger();

  try {
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 00 uploadToAmazon entered", {
      buildId: AMAZON_UPLOADFEED_BUILD_ID,
      taskId: uploadTaskId,
      batchId: uploadBatchId,
      filename: stableFileObj?.name,
      fileSize: stableFileObj?.size,
    });

    const originalTsv = typeof stableFileObj?.text === "function" ? await stableFileObj.text() : "";
    const validatedTsv = validateConfirmShipmentTsv(originalTsv);
    stableFileObj = new File([validatedTsv.content], stableFileObj.name, {
      type: stableFileObj.type || "text/tab-separated-values; charset=utf-8",
    });
    const lineBreakAudit = auditTsvLineBreaks(validatedTsv.content);
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] ConfirmShipment TSV line break audit", {
      hasCRLF: lineBreakAudit.hasCRLF,
      crlfCount: lineBreakAudit.crlfCount,
      lfCount: lineBreakAudit.lfCount,
      lineCount: lineBreakAudit.lineCount,
      headerLine: lineBreakAudit.headerLine,
      firstDataLine: lineBreakAudit.firstDataLine,
      headerDataConcatenated: lineBreakAudit.headerDataConcatenated,
    }, lineBreakAudit.headerDataConcatenated ? "error" : "success");
    if (lineBreakAudit.headerDataConcatenated) {
      throw createAmazonUploadError(
        "AMAZON_TSV_VALIDATION_FAILED",
        "Confirm shipment TSV header and first data row are concatenated; missing newline after header.",
        { lineBreakAudit }
      );
    }
    await chrome.storage.local.set({
      lastUploadTrackingFinalTsv: {
        batchId: uploadBatchId,
        taskId: uploadTaskId,
        filename: stableFileObj.name,
        content: validatedTsv.content,
        contentJsonPreview: JSON.stringify(validatedTsv.content.slice(0, 500)),
        lineBreakAudit,
        rows: validatedTsv.rows,
        tsvLength: validatedTsv.content.length,
        tsvChecksum: computeUploadTrackingChecksum(validatedTsv.content),
        createdAt: new Date().toISOString()
      }
    });
    const finalLines = validatedTsv.content.replace(/\n$/, "").split(/\r?\n/);
    finalTsvHeader = finalLines[0] || "";
    finalTsvFirstDataLine = finalLines[1] || "";
    finalTsvLineCount = finalLines.filter((line) => line.trim()).length;
    finalTsvChecksum = computeUploadTrackingChecksum(validatedTsv.content);
    finalTsvLength = validatedTsv.content.length;

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] ConfirmShipment ship-date audit", {
      marketplaceTimeZone: AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE,
      marketplaceToday: validatedTsv.marketplaceToday || formatDateYmdInTimeZone(new Date()),
      finalTsvFirstDataLine,
      shipDateFutureClampedRows: (validatedTsv.shipDateFutureClampedRows || []).join(","),
    }, "info");

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 02 TSV validation complete", {
      rows: validatedTsv.rows,
      tsvLength: finalTsvLength,
      tsvChecksum: finalTsvChecksum,
      finalTsvHeader,
      finalTsvFirstDataLine,
    }, "success");

    if (extensionLogger) {
      await extensionLogger.logUploadStarted(
        {
          filename: stableFileObj.name,
          fileSize: stableFileObj.size,
          progress: 0,
          carrier: uploadParams?.carrierCode,
          shipMethod: uploadParams?.shipMethod,
          ordersUploaded: 0,
        },
        {
          taskId: uploadTaskId,
          taskType: "UPLOAD_TRACKING",
          batchId: uploadBatchId,
        },
        "Starting upload to Amazon Seller Central"
      );
    }

    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "info",
      message: `Starting upload to Amazon: ${stableFileObj.name}`,
    });

    dedicatedSellerCentralTab = await findOrOpenSellerCentralFeedsTab({ dedicated: true, active: true });
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] opened dedicated Seller Central feeds tab", {
      tabId: dedicatedSellerCentralTab?.id || null,
      url: dedicatedSellerCentralTab?.url || SC_FEEDS_URL,
    }, "info");

    preflight = await getSellerCentralUploadPagePreflight({
      taskId: uploadTaskId,
      batchId: uploadBatchId,
      sellerCentralTabId: dedicatedSellerCentralTab?.id || null,
    });
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 07B Seller Central page preflight result", {
      ok: preflight.ok,
      tabId: preflight.tabId,
      finalUrl: preflight.finalUrl,
      pageTitle: preflight.pageTitle,
      tabStatus: preflight.tabStatus,
      feedsPage: preflight.feedsPage,
      isLoginPage: preflight.isLoginPage,
      isOtpPage: preflight.isOtpPage,
      isCaptchaPage: preflight.isCaptchaPage,
      isMarketplaceSelector: preflight.isMarketplaceSelector,
      isSellerCentralPage: preflight.isSellerCentralPage,
      allowUpload: preflight.allowUpload,
      snifferInstalled: preflight.snifferInstalled,
    }, preflight.allowUpload ? "success" : "error");

    if (!preflight.allowUpload) {
      throw createAmazonUploadError(
        "AMAZON_AUTH_REQUIRED",
        "Amazon Seller Central feeds page is not ready for upload. Log in, clear any OTP/captcha/marketplace selector, then retry.",
        { preflight, retryable: true, userActionRequired: true }
      );
    }

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] native Seller Central upload is ready", {
      sellerCentralReady: preflight.allowUpload,
      strategy: "nativeSellerCentralForm",
    }, "success");
    historyBeforeBatchIds = (await readAmazonFeedHistory(dedicatedSellerCentralTab.id).catch(() => []))
      .map((row) => row.amazonBatchId)
      .filter(Boolean);

    const cookieFlags = {
      sessionId: !!(await getCookie(`${SC_BASE}/`, "session-id")),
      sessionToken: !!(await getCookie(`${SC_BASE}/`, "session-token")),
      ubidMain: !!(await getCookie(`${SC_BASE}/`, "ubid-main")),
      csrfCookieFound: !!(await getCookie(`${SC_BASE}/`, "anti-csrftoken-a2z")),
    };
    if (!cookieFlags.sessionId || !cookieFlags.sessionToken) {
      logUploadTrackingDiagnostic("[UPLOAD_TRACKING] Seller Central tab preflight passed; continuing despite missing cookie API session flags", cookieFlags);
    }

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 08 FormData contract expected", {
      fields: "native #fileToUpload + input[name=upload]",
      csrfExpected: false,
      csrfHeaderIncluded: false,
      finalTsvHeader,
      finalTsvFirstDataLine,
      finalTsvLineCount,
      finalTsvChecksum,
      finalTsvLength,
      filename: stableFileObj.name,
      fileSize: stableFileObj.size,
    });

    const requestStartTime = Date.now();
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 09 strategy selected", {
      strategy: "sellerCentralTabPageContext",
      csrfHeaderIncluded: false,
      filename: stableFileObj.name,
      fileSize: stableFileObj.size,
      tsvChecksum: finalTsvChecksum,
    });
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 10 request sending", {
      strategy: "nativeSellerCentralForm",
      uploadPath: "Seller Central UI handler",
      filename: stableFileObj.name,
    });

    pageUploadResult = await uploadToAmazonViaNativeSellerCentralForm(stableFileObj, {
      ...uploadParams,
      sellerCentralTabId: dedicatedSellerCentralTab?.id || null,
    });
    const requestDuration = Date.now() - requestStartTime;
    const response = sellerCentralTabUploadResultToResponse(pageUploadResult);
    const contentType = response.headers.get("content-type") || "";
    const responseText = pageUploadResult?.textPreview || "";

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed FormData runtime result", {
      fields: "feedFile|feedName|feedVersion|csrfToken",
      csrfIncluded: !!pageUploadResult?.csrfIncluded,
      csrfSource: pageUploadResult?.csrfSource || "none",
      csrfTokenLength: pageUploadResult?.csrfTokenLength || 0,
      liveExtractionFound: !!pageUploadResult?.liveExtractionFound,
      cachedTokenFound: !!pageUploadResult?.cachedTokenFound,
      snifferInstalled: !!pageUploadResult?.snifferInstalled,
      world: pageUploadResult?.world,
      status: response.status,
    }, pageUploadResult?.csrfIncluded ? "success" : "error");
    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 11 response received", {
      status: response.status,
      statusText: response.statusText,
      contentType,
      url: response.url,
      requestDuration,
      world: pageUploadResult?.world,
      csrfHeaderIncluded: false,
    }, response.ok ? "success" : "error");

    if (pageUploadResult?.code === "AMAZON_UPLOAD_CSRF_FORM_FIELD_MISSING") {
      logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed csrfToken FormData field missing", {
        world: pageUploadResult?.world,
        finalUrl: pageUploadResult?.finalUrl || pageUploadResult?.url || "",
        pageTitle: pageUploadResult?.pageTitle || "",
        readyState: pageUploadResult?.readyState || "",
        isSellerCentralPage: !!pageUploadResult?.isSellerCentralPage,
        isFeedsPage: !!pageUploadResult?.isFeedsPage,
        csrfSource: pageUploadResult?.csrfSource || "none",
        csrfTokenLength: pageUploadResult?.csrfTokenLength || 0,
        liveExtractionFound: !!pageUploadResult?.liveExtractionFound,
        cachedTokenFound: !!pageUploadResult?.cachedTokenFound,
        snifferInstalled: !!pageUploadResult?.snifferInstalled,
        instruction: pageUploadResult?.instruction || "Open Seller Central feeds page and perform one manual upload to let the extension capture uploadFeed csrfToken.",
      }, "error");
      throw createAmazonUploadError(
        "AMAZON_UPLOAD_CSRF_FORM_FIELD_MISSING",
        "Valid uploadFeed csrfToken FormData field is missing in Seller Central page context.",
        {
          status: 0,
          preflight,
          retryable: !preflight?.allowUpload,
          userActionRequired: !preflight?.allowUpload,
          uploadResult: pageUploadResult,
        }
      );
    }

    let result;
    if (isJson(response)) {
      result = pageUploadResult?.jsonParseOk ? pageUploadResult.json : await response.json();
      logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 12 response parsed", {
        jsonParseOk: true,
        keys: result && typeof result === "object" ? Object.keys(result).join(",") : "",
        success: result?.success,
        message: result?.message || "",
      }, result?.success === false ? "error" : "success");
    } else {
      result = responseText;
      logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 12 response parsed", {
        jsonParseOk: false,
        textPreview: responseText.slice(0, 500),
      }, response.ok ? "info" : "error");
    }

    if (!response.ok) {
      const errorCode = classifyAmazonUploadFailure(response, responseText);

      throw createAmazonUploadError(
        errorCode,
        `Amazon upload failed [${errorCode}] with status ${response.status}: ${responseText.slice(0, 200)}`,
        {
          status: response.status,
          statusText: response.statusText,
          responseText,
          uploadUrl: response.url,
          retryable: errorCode === "AMAZON_AUTH_REQUIRED",
          userActionRequired: errorCode === "AMAZON_AUTH_REQUIRED",
        }
      );
    }

    if (response.status === 200 && isJson(response) && result?.success === false) {
      throw createAmazonUploadError(
        "AMAZON_UPLOAD_REJECTED",
        result?.message || "Amazon uploadFeed rejected the confirmShipment feed.",
        { status: response.status, statusText: response.statusText, response: result, retryable: false }
      );
    }

    const duration = Date.now() - startTime;
    if (extensionLogger) {
      await extensionLogger.logUploadCompleted(
        {
          filename: stableFileObj.name,
          fileSize: stableFileObj.size,
          progress: 100,
          ordersUploaded: uploadParams?.ordersCount || 0,
          response: result,
        },
        { taskId: uploadTaskId, taskType: "UPLOAD_TRACKING", batchId: uploadBatchId },
        {
          duration,
          requestDuration,
          endpoint: response.url || `${SC_BASE}${AMAZON_UPLOADFEED_URL_PATH}`,
          strategy: "sellerCentralTabPageContext",
          world: pageUploadResult?.world,
        },
        "Amazon upload completed successfully"
      );
    }

    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "success",
      message: `Amazon upload completed: ${stableFileObj.name}`,
    });

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 13 success", {
      status: response.status,
      contentType,
      strategy: "sellerCentralTabPageContext",
      world: pageUploadResult?.world,
      csrfFormFieldIncluded: !!pageUploadResult?.csrfIncluded,
      csrfHeaderIncluded: false,
      taskId: uploadTaskId,
      batchId: uploadBatchId,
    }, "success");

    return {
      ok: true,
      result,
      status: response.status,
      endpoint: response.url || `${SC_BASE}${AMAZON_UPLOADFEED_URL_PATH}`,
      duration,
      requestDuration,
      strategy: "sellerCentralTabPageContext",
      world: pageUploadResult?.world,
      dedicatedSellerCentralTabId: dedicatedSellerCentralTab?.id || null,
      historyBeforeBatchIds,
    };
  } catch (error) {
    if (isUploadFeedAuthOrCsrfError(error)) {
      await clearUploadFeedCsrfCache("auth_or_csrf_failure", {
        code: error?.code || "UNKNOWN_ERROR",
        status: error?.status || 0,
      }).catch(() => { });
    }

    logUploadTrackingDiagnostic("[UPLOAD_TRACKING] PHASE 99 exception", {
      code: error?.code || "UNKNOWN_ERROR",
      message: error?.message || String(error),
      status: error?.status || 0,
      taskId: uploadTaskId,
      batchId: uploadBatchId,
      retryable: !!error?.retryable,
      userActionRequired: !!error?.userActionRequired,
    }, "error");

    if (extensionLogger) {
      await extensionLogger.logUploadFailed(
        {
          filename: stableFileObj?.name,
          fileSize: stableFileObj?.size,
          progress: 0,
          ordersUploaded: 0,
        },
        { taskId: uploadTaskId, taskType: "UPLOAD_TRACKING", batchId: uploadBatchId },
        error,
        "Amazon upload failed"
      );
    }

    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "error",
      message: `Amazon upload failed: ${error.code || "UNKNOWN_ERROR"} - ${error.message}`,
    }).catch(() => { });

    throw error;
  }
}

async function DO_NOT_USE_uploadToAmazonLegacyBackgroundUpload() {
  throw new Error("Deprecated: uploadFeed must use Seller Central page-context upload. Do not use background upload.");
}

async function postLogSingle({
  base,
  token,
  shopId,
  machineId,
  label,
  action = "click",
  level = "info",
  message,
}) {
  try {
    await fetch(`${base}/api/logs/add`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-token": token || "",
      },
      body: JSON.stringify({
        shopId,
        machineId,
        label,
        action,
        level,
        message,
      }),
    });
  } catch (_) { }
}

async function getBaseShopAndIdentity() {
  const st = await chrome.storage.local.get([
    "ingestUrl",
    "shopId",
    "autoConnect",
  ]);
  const { clientId, clientLabel } = await ensureIdentity();
  const { base } = deriveApiUrls(st.ingestUrl);
  return {
    base,
    shopId: st.shopId || "",
    autoConnect: st.autoConnect !== false, // default true
    clientId,
    clientLabel,
  };
}

// Chạy đủ 3 bước và EMIT LOG TỔNG qua socket (không POST DB)
async function runFullFlowAndEmitLogs(trigger = "auto") {
  const { base, shopId, clientId, clientLabel } =
    await getBaseShopAndIdentity();
  const phases = [];
  const startTime = Date.now();
  const taskId = `import_orders_${startTime}`;

  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  // Log task processing start
  if (extensionLogger) {
    await extensionLogger.logTaskProcessing({
      taskId,
      taskType: 'IMPORT_ORDERS',
      batchId: taskId,
      ordersCount: 0
    }, `Starting full import flow (trigger: ${trigger})`);
  }

  try {
    const importResult = await runImportNewOrders(undefined);
    phases.push({
      type: "import",
      status: "success",
      rows: importResult?.rows || 0,
      referenceId: importResult?.referenceId || null,
      documentId: importResult?.documentId || null,
    });

    // Log task completed
    if (extensionLogger) {
      const endTime = Date.now();
      await extensionLogger.logTaskCompleted({
        taskId,
        taskType: 'IMPORT_ORDERS',
        batchId: taskId,
        ordersCount: importResult?.rows || 0
      }, {
        duration: endTime - startTime,
        memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
        cpuUsage: 0
      }, 'Import orders completed successfully');
    }

    await postLogSingle({
      base,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: trigger,
      level: "success",
      message: `\u2705 Import order success! rows=${importResult?.rows || 0}`,
    });

    return { ok: true, phases, result: importResult };
  } catch (error) {
    const errorMessage = error?.message || String(error);
    phases.push({
      type: "import",
      status: "fail",
      error: errorMessage,
    });

    // Log general error
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId,
        taskType: 'IMPORT_ORDERS',
        batchId: taskId,
        ordersCount: 0
      }, error, 'Import orders failed');

      await extensionLogger.logError(error, {
        trigger: trigger,
        function: 'runFullFlowAndEmitLogs'
      }, 'Full import flow error');
    }

    await postLogSingle({
      base,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: trigger,
      level: "error",
      message: `\u274C Import order error: ${errorMessage}`,
    });

    throw error;
  }
}

async function runImportOrdersOnce(trigger) {
  if (importOrdersInProgress) {
    const message = "[ORDER-LOCK] Skip IMPORT_ORDERS: another order import is running";
    debugLog(message, "info");
    extensionLogger?.logInfo(message);
    return { ok: true, skipped: true, reason: "IMPORT_ORDERS_ALREADY_RUNNING" };
  }

  importOrdersInProgress = true;
  try {
    return await runFullFlowAndEmitLogs(trigger);
  } finally {
    importOrdersInProgress = false;
  }
}

//  Handle Confirm Shipping
async function handleImportFBMOrders(trigger = "auto") {
  const { base, shopId, clientId, clientLabel } =
    await getBaseShopAndIdentity();
  try {
    await runImportFBMOrders(undefined, shopId, clientLabel);
    await postLogSingle({
      base,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: trigger,
      level: "success",
      message: "✅ Import FBM order success!",
    });
  } catch (e) {
    await postLogSingle({
      base,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: trigger,
      level: "error",
      message: "❌ Import FBM order error!",
    });
  }
  return { ok: true, message: "Import FBM order success!" };
}

/* ===============================
   Auto-capture Amazon Ads headers (CSRF) via webRequest
   =============================== */
const ADS_HEADER_KEYS = {
  "amazon-ads-account-id": "adsAccountId",
  "amazon-advertising-api-advertiserid": "adsAdvertiserId",
  "amazon-advertising-api-clientid": "adsClientId",
  "amazon-advertising-api-marketplaceid": "adsMarketplaceId",
  "amazon-advertising-api-csrf-data": "adsCsrfData",
  "amazon-advertising-api-csrf-token": "adsCsrfToken",
};

function collectAdsHeaders(requestHeaders = []) {
  const out = {};
  for (const h of requestHeaders) {
    const k = String(h.name || "").toLowerCase();
    const key = ADS_HEADER_KEYS[k];
    if (key) out[key] = h.value || "";
  }
  return out;
}

let lastAdsHeaderWriteAt = 0;

async function saveAdsHeadersIfAny(found) {
  const clean = Object.fromEntries(
    Object.entries(found || {}).filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
  );
  const keys = Object.keys(clean);
  if (!keys.length) return;
  const now = Date.now();

  if (isAdsApiLocked()) {
    await chrome.storage.local.set({
      adsCandidateHeaders: {
        ...clean,
        adsHeaderLastSeen: now,
        source: "webRequest",
        capturedAt: now,
      },
    });
    return;
  }

  const current = await chrome.storage.local.get(ADS_HEADER_STORAGE_KEYS);
  const merged = { ...current, ...clean };
  const changed = keys.some((k) => clean[k] && clean[k] !== current[k]);
  const hasCoreHeaders = isAdsHeaderComplete(merged);
  const capturedComplete = isAdsHeaderComplete(clean);
  const shouldLogCapture = capturedComplete && (changed || !current.adsHeaderLastSeen);

  // Chỉ header đầy đủ của cùng một request mới được xem là CSRF fresh.
  // Partial capture phải không được gia hạn token cũ còn trong storage.
  if (!changed && hasCoreHeaders && now - lastAdsHeaderWriteAt < 5000) return;

  const payload = { ...clean };
  if (capturedComplete) payload.adsHeaderLastSeen = now;

  await chrome.storage.local.set(payload);
  lastAdsHeaderWriteAt = now;

  if (shouldLogCapture) {
    log("[ADS] headers captured:", keys.join(", "));
    extensionLogger?.logInfo("[ADS-AUTH] Ads headers captured", {
      keys,
      changed,
      hasCoreHeaders,
      lastSeen: payload.adsHeaderLastSeen,
    });
  }
}

/* ===============================
   CSRF headers: age is informational. Amazon decides whether a complete
   session is still valid; refresh only after a real auth failure.
   =============================== */
const ADS_HEADER_TTL_MS = 20 * 60 * 1000;

async function forceRefreshAdsHeaders(options = {}) {
  const reason = typeof options === "string" ? options : options.reason || "manual";
  options = typeof options === "string" ? {} : options;
  if (isAdsApiLocked() && !isAdsLockOwner(options.runId)) {
    debugLog("[ADS-AUTH] force refresh blocked: not lock owner", "error");
    extensionLogger?.logInfo("[ADS-AUTH] force refresh blocked: not lock owner", {
      reason,
      callerRunId: options.runId,
      callerTaskName: options.taskName,
      lock: { ...adsApiLock },
    });
    const err = createAdsError("ADS_LOCK_NOT_OWNER: cannot force refresh Ads headers while another Ads task owns the lock", 0, "");
    err.code = "ADS_LOCK_NOT_OWNER";
    throw err;
  }

  if (isAdsApiLocked()) {
    debugLog("[ADS-AUTH] force refresh allowed under lock", "info");
    extensionLogger?.logInfo("[ADS-AUTH] force refresh allowed under lock", {
      reason,
      runId: options.runId,
      taskName: options.taskName,
    });
  }

  const startedAt = Date.now();
  debugLog(`🔄 [ADS-AUTH] Force refresh Ads headers — reason: ${reason}`, "info");
  extensionLogger?.logInfo("[ADS-AUTH] Force refresh Ads headers", { reason });

  const { tabId } = await ensureAdsTab();
  await ensureAdsBridgeInjected(tabId);
  await delayMs(ADS_PAGE_SETTLE_MS);

  // A reload restarts this slow page and still does not guarantee a request
  // that exposes CSRF. Wait once; if Amazon needs a new session, show an
  // actionable error instead of repeatedly reloading the seller's tab.
  const captured = await waitForAdsHeaderCapture({ since: startedAt, timeoutMs: ADS_HEADER_REFRESH_TIMEOUT_MS });

  let latest = await readAdsHeaderState();
  if (captured && !isAdsHeaderComplete(latest)) {
    const { adsCandidateHeaders } = await chrome.storage.local.get(["adsCandidateHeaders"]);
    const candidateFresh = Number(adsCandidateHeaders?.adsHeaderLastSeen || 0) >= startedAt - 1000;
    if (candidateFresh && isAdsHeaderComplete(adsCandidateHeaders || {}) && canMutateAdsHeaders(options)) {
      const promoted = {};
      for (const key of ADS_HEADER_STORAGE_KEYS) {
        if (adsCandidateHeaders[key]) promoted[key] = adsCandidateHeaders[key];
      }
      await chrome.storage.local.set(promoted);
      await chrome.storage.local.remove(["adsCandidateHeaders"]);
      latest = await readAdsHeaderState();
      debugLog("[ADS-AUTH] Promoted candidate Ads headers after owner refresh", "success");
      extensionLogger?.logInfo("[ADS-AUTH] Promoted candidate Ads headers after owner refresh", {
        reason,
        runId: options.runId,
        taskName: options.taskName,
      });
    }
  }
  if (captured && isAdsHeaderComplete(latest)) {
    debugLog("✅ [ADS-AUTH] Fresh Ads headers ready", "success");
    extensionLogger?.logInfo("[ADS-AUTH] Fresh Ads headers ready", {
      lastSeen: latest.adsHeaderLastSeen,
      ageSeconds: Math.round((Date.now() - Number(latest.adsHeaderLastSeen || 0)) / 1000),
    });
    return true;
  }

  const hint = await getAdsPageHint(tabId);
  const reasonText = isAdsSignInText(`${hint.href || ""}
${hint.title || ""}
${hint.bodyText || ""}`)
    ? "Amazon Ads đang yêu cầu login/reauth. Mở tab advertising.amazon.com, đăng nhập lại rồi chạy lại."
    : "Không capture được Ads headers từ Amazon Ads page. Giữ tab Ads mở cho tới khi tải xong, refresh thủ công một lần rồi chạy lại.";

  const error = createAdsError(`Không thể refresh Ads headers: ${reasonText}`, 401, JSON.stringify(hint).slice(0, 1000));
  error.adsRefreshFailed = true;
  throw error;
}

async function ensureFreshAdsHeaders(options = {}) {
  const { force = false, reason = "preflight" } = options;
  const st = await readAdsHeaderState();
  const age = st.adsHeaderLastSeen ? Date.now() - Number(st.adsHeaderLastSeen) : Infinity;
  const isComplete = isAdsHeaderComplete(st);
  const isFresh = isComplete && age < ADS_HEADER_TTL_MS;
  const status = !isComplete ? "missing" : isFresh ? "valid" : "stale";

  debugLog(`🔑 [ADS-AUTH] Header status: ${status} — age ${Math.round(age / 1000)}s`, isComplete ? "info" : "error");
  extensionLogger?.logInfo("[ADS-AUTH] Header preflight", {
    force,
    reason,
    isComplete,
    isFresh,
    ageSeconds: Math.round(age / 1000),
    hasAccountId: !!st.adsAccountId,
    hasAdvertiserId: !!st.adsAdvertiserId,
    hasClientId: !!st.adsClientId,
    hasMarketplaceId: !!st.adsMarketplaceId,
    hasCsrfData: !!st.adsCsrfData,
    hasCsrfToken: !!st.adsCsrfToken,
  });

  // Do not reload a slow Ads page merely because the cached header is old.
  // fetchAdsJsonCS refreshes after Amazon confirms an auth failure (401/403).
  if (!force && isComplete) return true;
  return forceRefreshAdsHeaders({ ...options, reason });
}


chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      if (!details?.url?.startsWith(ADS_BASE)) return;
      // Ignore requests originated by the extension itself. A failed
      // retrieveReport carries the old CSRF and must never become "fresh".
      if (details.tabId < 0 || String(details.initiator || "").startsWith("chrome-extension://")) return;
      const found = collectAdsHeaders(details.requestHeaders || []);
      saveAdsHeadersIfAny(found);
    } catch { }
  },
  { urls: [`${ADS_BASE}/*`] },
  ["requestHeaders", "extraHeaders"]
);

/* ================================================================
   SOCKET.IO AUTO CONNECT + KEEPALIVE (Realtime only)
   ================================================================ */

let socket = null;
let hbTimer = null;
let connectBusy = false;

// Auto reconnect polling
let autoReconnectInterval = null;

function safeLogConnectionStatus(status, details = {}, message = "") {
  try {
    if (!extensionLogger) return;
    Promise.resolve(
      extensionLogger.logConnectionStatus(status, details, message)
    ).catch((error) => {
      console.warn("[SOCKET-LOG] safeLogConnectionStatus failed:", error?.message || error);
    });
  } catch (error) {
    console.warn("[SOCKET-LOG] safeLogConnectionStatus exception:", error?.message || error);
  }
}

function safeLogInfo(message, rawData = {}) {
  try {
    if (!extensionLogger) return;
    Promise.resolve(extensionLogger.logInfo(message, rawData)).catch((error) => {
      console.warn("[SOCKET-LOG] safeLogInfo failed:", error?.message || error);
    });
  } catch (error) {
    console.warn("[SOCKET-LOG] safeLogInfo exception:", error?.message || error);
  }
}

function safePostLogSingle(payload) {
  try {
    Promise.resolve(postLogSingle(payload)).catch((error) => {
      console.warn("[SOCKET-LOG] safePostLogSingle failed:", error?.message || error);
    });
  } catch (error) {
    console.warn("[SOCKET-LOG] safePostLogSingle exception:", error?.message || error);
  }
}

function startHeartbeat() {
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = setInterval(async () => {
    if (!socket || !socket.connected) return;
    const { clientLabel } = await ensureIdentity();
    socket.emit("ext:heartbeat", {
      label: clientLabel,
      version: "ext-" + chrome.runtime.getManifest().version,
      ua: navigator.userAgent,
      ip: null,
    });
  }, 15000);
}
function stopHeartbeat() {
  if (hbTimer) clearInterval(hbTimer);
  hbTimer = null;
}

function ensureSocketReconnectAlarm() {
  chrome.alarms.create(SOCKET_RECONNECT_ALARM, {
    periodInMinutes: SOCKET_RECONNECT_PERIOD_MINUTES,
  });
}

async function ensureAmazonFeedWatchAlarm() {
  const watches = await getAmazonFeedWatches();
  if (Object.keys(watches).length > 0) {
    chrome.alarms.create(AMAZON_FEED_WATCH_ALARM, { periodInMinutes: AMAZON_FEED_WATCH_PERIOD_MINUTES });
  }
}

async function reconnectSocketIfNeeded(source) {
  const { autoConnect } = await chrome.storage.local.get(["autoConnect"]);
  if (!shouldReconnectSocket({ autoConnect, connected: socket?.connected })) return;

  safeLogConnectionStatus("reconnecting", { source }, `Socket reconnect triggered by ${source}`);
  await connectSocketIO();
}

/**
 * Kết nối Socket.IO.
 * - force = true: luôn ngắt và tạo lại kết nối (dùng cho nút Connect hoặc đổi shop/ingestUrl)
 * - nếu đã có socket.connected thì bỏ qua (trừ khi force)
 */
// export async function connectSocketIO(force = false) {
//   if (connectBusy) return { ok: false, reason: "busy" };
//   connectBusy = true;
//   try {
//     const { base, shopId, clientId, clientLabel } =
//       await getBaseShopAndIdentity();
//     if (!base) {
//       console.log("[SOCKET] Missing base");
//       return { ok: false, reason: "base missing" };
//     }
//     if (!shopId) {
//       console.log("[SOCKET] Missing shopId");
//       return { ok: false, reason: "shopId missing" };
//     }

//     // Khi không force và đang connected thì thôi
//     if (!force && socket && socket.connected) {
//       return { ok: true, message: "already connected" };
//     }

//     // Nếu có socket cũ, disconnect trước
//     if (socket) {
//       try {
//         socket.disconnect();
//       } catch {}
//       socket = null;
//     }

//     socket = io(base, {
//       path: "/ws",
//       transports: ["websocket"],
//       auth: {
//         shopId,
//         machineId: clientId,
//         label: clientLabel,
//         version: "ext-" + chrome.runtime.getManifest().version,
//         ua: navigator.userAgent,
//       },
//       reconnection: true,
//       reconnectionAttempts: Infinity,
//       reconnectionDelay: 2000,
//       reconnectionDelayMax: 10000,
//       timeout: 180000,
//     });

//     socket.on("connect", async () => {
//       console.log("[SOCKET] connected", socket.id);
//       await postLogSingle({
//         base,
//         shopId,
//         machineId: clientId,
//         label: clientLabel,
//         action: "auto",
//         level: "success",
//         message: `✅ Extension connected to Socket.IO`,
//       });
//       startHeartbeat();
//     });

//     socket.on("disconnect", async (reason) => {
//       console.log("[SOCKET] disconnected:", reason);
//       await postLogSingle({
//         base,
//         shopId,
//         machineId: clientId,
//         label: clientLabel,
//         action: "auto",
//         level: "error",
//         message: `❌ Extension disconnected to Socket.IO`,
//       });
//       stopHeartbeat();
//       // để reconnection tự xử lý (đã bật trong options ở trên)
//     });

//     // (tuỳ chọn) nhận task từ server nếu bạn vẫn muốn bắn lệnh IMPORT_ORDERS
//     socket.on("server:task", async (task) => {
//       const { type, payload } = task || {};
//       try {
//         switch (type) {
//           case "IMPORT_FBM_ORDERS":
//             handleImportFBMOrders("click");
//             break;
//           case "IMPORT_ORDERS":
//             runFullFlowAndEmitLogs("click");
//             break;
//           case "IMPORT_ADS_SPEND":
//             const day = payload?.date;
//             if (!day) throw new Error("Missing payload.date");
//             try {
//               await runExportAdsSpend(day);
//               await postLogSingle({
//                 base,
//                 shopId,
//                 machineId: clientId,
//                 label: clientLabel,
//                 action: "click",
//                 level: "success",
//                 message: "✅ Import ads success!",
//               });
//             } catch (error) {
//               await postLogSingle({
//                 base,
//                 shopId,
//                 machineId: clientId,
//                 label: clientLabel,
//                 action: "click",
//                 level: "error",
//                 message: "❌ Import ads error!",
//               });
//             }
//             break;
//           default:
//             break;
//         }
//       } catch (e) {
//         console.error("[SOCKET] task error:", e?.message || e);
//       }
//     });

//     return { ok: true };
//   } finally {
//     connectBusy = false;
//   }
// }

export async function connectSocketIO(force = false) {
  console.log("[SOCKET-LOG] connectSocketIO entered", {
    force,
    connectBusy,
    socketExists: !!socket,
    socketConnected: !!socket?.connected
  });

  if (connectBusy) {
    console.log('[SOCKET-LOG] Connection already in progress, skipping...');
    safeLogConnectionStatus('busy', { force }, 'Socket connection already in progress');
    return { ok: false, reason: "busy" };
  }
  connectBusy = true;

  try {
    const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();

    console.log('[SOCKET-LOG] Starting socket connection...', { base, shopId, clientId, clientLabel, force });
    safeLogConnectionStatus('connecting', {
      base, shopId, clientId, clientLabel, force
    }, 'Initiating Socket.IO connection');

    if (!base) {
      console.error('[SOCKET-LOG] Missing base URL');
      safeLogConnectionStatus('failed', { reason: 'base_missing' }, 'Socket connection failed: Missing base URL');
      return { ok: false, reason: "base missing" };
    }

    if (!shopId) {
      console.error('[SOCKET-LOG] Missing shopId');
      safeLogConnectionStatus('failed', { reason: 'shopid_missing' }, 'Socket connection failed: Missing shopId');
      return { ok: false, reason: "shopId missing" };
    }

    // Nếu đã connected và không force → bỏ qua
    if (!force && socket?.connected) {
      console.log('[SOCKET-LOG] Already connected, skipping reconnection');
      safeLogConnectionStatus('already_connected', { socketId: socket?.id || null }, 'Socket already connected');
      return { ok: true, message: "already connected" };
    }

    // Ngắt socket cũ nếu có
    if (socket) {
      console.log('[SOCKET-LOG] Disconnecting existing socket...');
      safeLogConnectionStatus('disconnecting_old', {
        oldSocketId: socket?.id || null,
        oldConnected: !!socket?.connected
      }, 'Disconnecting existing socket connection');
      try { socket.disconnect(); } catch { }
      socket = null;
      stopHeartbeat();

      // Dừng auto reconnect polling khi cleanup socket
      if (force) stopAutoReconnectPolling();
    }

    console.log("[SOCKET-LOG] Creating new socket connection", {
      url: base,
      path: "/ws",
      shopId,
      machineId: clientId,
      label: clientLabel
    });

    socket = io(base, {
      path: "/ws",
      transports: ["websocket"],
      auth: {
        shopId,
        machineId: clientId,
        label: clientLabel,
        version: "ext-" + chrome.runtime.getManifest().version,
        ua: navigator.userAgent,
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 180000,
    });

    const connected = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket connection timed out")), 15000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve({ ok: true });
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timeout);
        reject(error || new Error("Socket connection failed"));
      });
    });

    // Khi kết nối thành công
    socket.on("connect", () => {
      console.log("[SOCKET-LOG] Connected successfully", { socketId: socket?.id || null, timestamp: new Date().toISOString() });
      startHeartbeat();
      startAutoReconnectPolling();
      Promise.resolve(clearLegacyAutoConfigAlarms()).catch((error) => {
        debugLog(`[TASKS] Could not clear legacy alarms: ${error.message}`, "error");
      });
      socket.emit("client:pull_pending_tasks", { shopId, machineId: clientId }, (result) => {
        debugLog(`[TASKS] Pending tasks pulled: ${result?.count || 0}`, "info");
      });

      safeLogConnectionStatus('connected', {
        socketId: socket?.id || null,
        timestamp: new Date().toISOString(),
        reconnectionAttempts: socket?.io?.reconnectionAttempts || 0
      }, 'Socket.IO connection established successfully');

      safePostLogSingle({
        base, shopId, machineId: clientId, label: clientLabel,
        action: "auto", level: "success",
        message: "✅ Extension connected to Socket.IO",
      });
    });

    // Khi mất kết nối
    socket.on("disconnect", (reason) => {
      console.log("[SOCKET-LOG] ❌ Disconnected:", { reason, timestamp: new Date().toISOString() });

      safeLogConnectionStatus('disconnected', {
        reason,
        timestamp: new Date().toISOString(),
        wasConnected: true
      }, `Socket disconnected: ${reason}`);

      safePostLogSingle({
        base, shopId, machineId: clientId, label: clientLabel,
        action: "auto", level: "error",
        message: `❌ Socket disconnected: ${reason}`,
      });
      stopHeartbeat();

      // Dừng auto reconnect polling khi socket ngắt kết nối
      // Keep auto reconnect polling alive during normal disconnects.

      // Nếu server ép disconnect → force reconnect ngay
      if (reason === "io server disconnect") {
        console.log("[SOCKET-LOG] Server forced disconnect, attempting reconnection...");
        safeLogConnectionStatus('reconnecting', {
          reason: 'server_disconnect'
        }, 'Server forced disconnect, initiating reconnection');
        connectSocketIO(true);
      }
    });

    // Connection error handling
    socket.on("connect_error", (error) => {
      console.error("[SOCKET-LOG] connect_error", {
        message: error?.message,
        description: error?.description,
        context: error?.context,
        type: error?.type
      });
      console.error("[SOCKET-LOG] ❌ Connection error:", error);

      if (extensionLogger) {
        Promise.resolve(extensionLogger.logError(error, {
          socketUrl: base,
          shopId,
          clientId,
          timestamp: new Date().toISOString()
        }, 'Socket.IO connection error')).catch((logError) => {
          console.warn("[SOCKET-LOG] connect_error log failed:", logError?.message || logError);
        });
      }
    });

    // Reconnection events
    socket.on("reconnect", (attemptNumber) => {
      console.log("[SOCKET-LOG] ✅ Reconnected after", attemptNumber, "attempts");

      if (extensionLogger) {
        safeLogConnectionStatus('reconnected', {
          attemptNumber,
          timestamp: new Date().toISOString()
        }, `Successfully reconnected after ${attemptNumber} attempts`);
      }
    });

    socket.on("reconnect_attempt", (attemptNumber) => {
      console.log("[SOCKET-LOG] 🔄 Reconnection attempt", attemptNumber);

      if (extensionLogger) {
        safeLogConnectionStatus('reconnect_attempt', {
          attemptNumber,
          timestamp: new Date().toISOString()
        }, `Reconnection attempt #${attemptNumber}`);
      }
    });

    socket.on("reconnect_failed", () => {
      console.error("[SOCKET-LOG] ❌ Reconnection failed after all attempts");

      if (extensionLogger) {
        safeLogConnectionStatus('reconnect_failed', {
          timestamp: new Date().toISOString()
        }, 'Socket reconnection failed after all attempts');
      }
    });

    // Heartbeat tự động
    // Task từ server
    // socket.on("server:task", async (task) => {
    //   const { type, payload } = task || {};
    //   const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();
    //   log(`[SOCKET] Received task from server: ${type}`, payload);
    //   try {
    //     switch (type) {
    //       case "IMPORT_FBM_ORDERS": 
    //         handleImportFBMOrders("click"); 
    //         break;
    //       case "IMPORT_ORDERS": 
    //         runFullFlowAndEmitLogs("click"); 
    //         break;
    //       case "IMPORT_ADS_SPEND":
    //         if (!payload?.date) throw new Error("Missing payload.date");
    //         await runExportAdsSpend(payload.date);
    //         await postLogSingle({ 
    //           base, 
    //           token: (await getCfg()).ingestToken,
    //           shopId, 
    //           machineId: clientId, 
    //           label: clientLabel, 
    //           action: "click", 
    //           level: "success", 
    //           message: "✅ Import ads success!" 
    //         });
    //         break;
    //       case "UPLOAD_TRACKING":
    //         if (payload?.autoGenerated) {
    //           console.log(`🎯 Received auto UPLOAD_TRACKING task: ${payload.reason}`);

    //           // Log task start
    //           await postLogSingle({
    //             base,
    //             token: (await getCfg()).ingestToken,
    //             shopId,
    //             machineId: clientId,
    //             label: clientLabel,
    //             action: "auto",
    //             level: "info",
    //             message: `🎯 Starting UPLOAD_TRACKING task: ${payload.reason}`
    //           });

    //           const { file, uploadParams, trackingData } = payload;

    //           // 1. File TXT đã sẵn sàng, không cần tạo
    //           const blob = new Blob([file.content], { type: file.contentType });
    //           const fileObj = new File([blob], file.filename);

    //           // Log file preparation
    //           await postLogSingle({
    //             base,
    //             token: (await getCfg()).ingestToken,
    //             shopId,
    //             machineId: clientId,
    //             label: clientLabel,
    //             action: "auto",
    //             level: "info",
    //             message: `📄 Prepared file: ${file.filename} (${file.content.length} bytes)`
    //           });

    //           // Deprecated fire-and-forget upload removed; see handleServerTask.
    //         }
    //         break;
    //       default: 
    //         break;
    //     }
    //   } catch (e) {
    //     console.error("[SOCKET] task error:", e?.message || e);
    //   }
    // });
    socket.on("server:task", (task) => handleServerTask(task));

    return await connected;
  } finally {
    connectBusy = false;
  }
}

/* ===============================
   handleServerTask — dùng chung cho socket & test
   =============================== */
async function handleServerTask(task) {
  const { type, payload } = task || {};
  const serverTaskId = task?.taskId || payload?.taskId || "unknown";
  log(`[TASK] Nhận ${type || "UNKNOWN"} · ${serverTaskId}`);
  let identity;
  try {
    identity = await getBaseShopAndIdentity();
    console.log('🔑 [EXT-DEBUG] Extension identity:', {
      base: identity.base,
      shopId: identity.shopId,
      clientId: identity.clientId,
      clientLabel: identity.clientLabel
    });
  } catch (identityError) {
    console.error('❌ [EXT-DEBUG] Failed to get identity:', identityError);
    return;
  }

  const { base, shopId, clientId, clientLabel } = identity;
  const reportServerTask = (status, extra = {}) => {
    if (!serverTaskId || !socket?.connected) return;
    socket.emit("client:task", {
      eventId: `${serverTaskId}:${status}`,
      taskId: serverTaskId,
      type,
      status,
      shopId,
      machineId: clientId,
      source: "amazon_extension",
      reportedAt: new Date().toISOString(),
      ...extra,
    }, (ack) => {
      console.log(`[TASK_REPLY] BE acknowledged status=${status} taskId=${serverTaskId} ok=${!!ack?.ok}`);
    });
    console.log(`[TASK_REPLY] sent status=${status} taskId=${serverTaskId}`);
  };
  reportServerTask("received");
  let taskResult;
  let deferTaskCompletion = false;

  try {
    switch (type) {
      case "CONNECTION_TEST":
        console.log("[CONNECTION_TEST] BE task received");
        break;

      case "IMPORT_FBM_ORDERS":
        console.log('📋 [EXT-DEBUG] Handling IMPORT_FBM_ORDERS');

        // Initialize logger if not exists
        if (!extensionLogger) {
          await initializeLogger();
        }

        const fbmTaskId = `fbm_${Date.now()}`;
        const fbmStartTime = Date.now();

        // Log task received
        if (extensionLogger) {
          await extensionLogger.logTaskReceived({
            taskId: fbmTaskId,
            taskType: type,
            batchId: payload?.batchId || fbmTaskId,
            ordersCount: 0,
            filename: 'FBM Orders Import'
          }, '[IMPORT_FBM_ORDERS] Task received from server');
        }

        // Log task processing
        if (extensionLogger) {
          await extensionLogger.logTaskProcessing({
            taskId: fbmTaskId,
            taskType: type,
            batchId: payload?.batchId || fbmTaskId,
            ordersCount: 0
          }, '[IMPORT_FBM_ORDERS] Starting FBM orders import processing');
        }

        try {
          await handleImportFBMOrders("click");

          // Log task completed
          if (extensionLogger) {
            const fbmEndTime = Date.now();
            await extensionLogger.logTaskCompleted({
              taskId: fbmTaskId,
              taskType: type,
              batchId: payload?.batchId || fbmTaskId,
              ordersCount: 0
            }, {
              duration: fbmEndTime - fbmStartTime,
              memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
              cpuUsage: 0
            }, '[IMPORT_FBM_ORDERS] FBM orders import completed successfully');
          }
        } catch (error) {
          // Log task failed
          if (extensionLogger) {
            await extensionLogger.logTaskFailed({
              taskId: fbmTaskId,
              taskType: type,
              batchId: payload?.batchId || fbmTaskId,
              ordersCount: 0
            }, error, '[IMPORT_FBM_ORDERS] FBM orders import failed');
          }
          throw error;
        }
        break;

      case "IMPORT_ORDERS":
        console.log('📋 [EXT-DEBUG] Handling IMPORT_ORDERS');

        // Initialize logger if not exists
        if (!extensionLogger) {
          await initializeLogger();
        }

        const ordersTaskId = `orders_${Date.now()}`;
        const ordersStartTime = Date.now();

        // Log task received
        if (extensionLogger) {
          await extensionLogger.logTaskReceived({
            taskId: ordersTaskId,
            taskType: type,
            batchId: payload?.batchId || ordersTaskId,
            ordersCount: 0,
            filename: 'New Orders Import'
          }, '[IMPORT_ORDERS] Task received from server');
        }

        // Log task processing
        if (extensionLogger) {
          await extensionLogger.logTaskProcessing({
            taskId: ordersTaskId,
            taskType: type,
            batchId: payload?.batchId || ordersTaskId,
            ordersCount: 0
          }, '[IMPORT_ORDERS] Starting new orders import processing');
        }

        try {
          const importResult = await runImportOrdersOnce("socket");
          if (importResult?.skipped) {
            extensionLogger?.logInfo("[ORDER-LOCK] IMPORT_ORDERS skipped as duplicate", importResult);
            const error = new Error("IMPORT_ORDERS_ALREADY_RUNNING: task skipped");
            error.code = "IMPORT_ORDERS_ALREADY_RUNNING";
            throw error;
          }

          // Log task completed
          if (extensionLogger) {
            const ordersEndTime = Date.now();
            await extensionLogger.logTaskCompleted({
              taskId: ordersTaskId,
              taskType: type,
              batchId: payload?.batchId || ordersTaskId,
              ordersCount: 0
            }, {
              duration: ordersEndTime - ordersStartTime,
              memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
              cpuUsage: 0
            }, '[IMPORT_ORDERS] New orders import completed successfully');
          }
        } catch (error) {
          // Log task failed
          if (extensionLogger) {
            await extensionLogger.logTaskFailed({
              taskId: ordersTaskId,
              taskType: type,
              batchId: payload?.batchId || ordersTaskId,
              ordersCount: 0
            }, error, '[IMPORT_ORDERS] New orders import failed');
          }
          throw error;
        }
        break;

      case "IMPORT_ADS_SPEND":
        console.log('📋 [EXT-DEBUG] Handling IMPORT_ADS_SPEND');
        const adsStartDate = payload?.startDate || payload?.date;
        const adsEndDate = payload?.endDate || payload?.date;
        if (!adsStartDate || !adsEndDate) throw new Error("Missing payload.startDate/endDate");
        console.log('📅 [EXT-DEBUG] Ads spend range:', adsStartDate, adsEndDate);

        // Initialize logger if not exists
        if (!extensionLogger) {
          await initializeLogger();
        }

        const adsTaskId = `ads_${Date.now()}`;
        const adsStartTime = Date.now();

        // Log task received
        if (extensionLogger) {
          await extensionLogger.logTaskReceived({
            taskId: adsTaskId,
            taskType: type,
            batchId: payload?.batchId || `ads_${payload.date}`,
            ordersCount: 0,
            filename: `Ads Spend ${payload.date}`
          }, `[IMPORT_ADS_SPEND] Task received for date: ${payload.date}`);
        }

        // Log task processing
        if (extensionLogger) {
          await extensionLogger.logTaskProcessing({
            taskId: adsTaskId,
            taskType: type,
            batchId: payload?.batchId || `ads_${payload.date}`,
            ordersCount: 0
          }, `[IMPORT_ADS_SPEND] Starting ads spend import for date: ${payload.date}`);
        }

        let adsResult;
        try {
          adsResult = await runExportAdsSpendRange(adsStartDate, adsEndDate, { foreground: payload?.source === "manual" });
          taskResult = adsTaskSummary(adsResult);
          if (adsResult?.skipped && adsResult?.reason === "ADS_TASK_ALREADY_RUNNING") {
            extensionLogger?.logInfo("[ADS-LOCK] Skip IMPORT_ADS_SPEND, another Ads task is running", adsResult);
            break;
          }

          // Log task completed
          if (extensionLogger) {
            const adsEndTime = Date.now();
            await extensionLogger.logTaskCompleted({
              taskId: adsTaskId,
              taskType: type,
              batchId: payload?.batchId || `ads_${payload.date}`,
              ordersCount: 0,
              filename: `Ads Spend ${payload.date}`
            }, {
              duration: adsEndTime - adsStartTime,
              memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
              cpuUsage: 0
            }, `[IMPORT_ADS_SPEND] Ads spend import completed for date: ${payload.date}`);
          }

        } catch (error) {
          // Log task failed
          if (extensionLogger) {
            await extensionLogger.logTaskFailed({
              taskId: adsTaskId,
              taskType: type,
              batchId: payload?.batchId || `ads_${payload.date}`,
              ordersCount: 0,
              filename: `Ads Spend ${payload.date}`
            }, error, `[IMPORT_ADS_SPEND] Ads spend import failed for date: ${payload.date}`);
          }
          throw error;
        }

        await postLogSingle({
          base,
          token: (await getCfg()).ingestToken,
          shopId,
          machineId: clientId,
          label: clientLabel,
          action: "click",
          level: "success",
          message: "✅ Import ads success!"
        });
        break;

      case "UPLOAD_TRACKING":
        console.log('📋 [EXT-DEBUG] ===== HANDLING UPLOAD_TRACKING =====');

        if (payload?.source === "auto_scheduler" && !payload?.file) {
          await runUploadTrackingWithLock({ source: "auto_scheduler" });
          break;
        }

        // Initialize logger if not exists
        if (!extensionLogger) {
          await initializeLogger();
        }

        const uploadTaskId = payload?.batchId || payload?.taskId || `upload_${Date.now()}`;
        const uploadStartTime = Date.now();

        // Log task received with full details
        if (extensionLogger) {
          await extensionLogger.logTaskReceived({
            taskId: uploadTaskId,
            taskType: type,
            batchId: payload?.batchId,
            ordersCount: payload?.trackingData?.length || 0,
            filename: payload?.file?.filename
          }, `[UPLOAD_TRACKING] Task received: ${payload?.reason}`);
        }

        // Log task processing
        if (extensionLogger) {
          await extensionLogger.logTaskProcessing({
            taskId: uploadTaskId,
            taskType: type,
            batchId: payload?.batchId,
            ordersCount: payload?.trackingData?.length || 0,
            filename: payload?.file?.filename
          }, `[UPLOAD_TRACKING] Starting upload tracking processing: ${payload?.reason}`);
        }

        // Log to popup UI
        debugLog('� [UPLOAD_TRACKING] ===== TASK RECEIVED =====', 'info');
        debugLog(`🎯 [UPLOAD_TRACKING] Task Type: ${payload?.autoGenerated ? 'AUTO GENERATED' : 'MANUAL TRIGGER'}`, payload?.autoGenerated ? 'success' : 'info');
        debugLog(`📝 [UPLOAD_TRACKING] Reason: ${payload?.reason}`, 'info');
        debugLog(`🏷️ [UPLOAD_TRACKING] Batch ID: ${payload?.batchId}`, 'info');
        debugLog(`👤 [UPLOAD_TRACKING] Requested By: ${payload?.requestedBy}`, 'info');
        debugLog(`⏰ [UPLOAD_TRACKING] Timestamp: ${payload?.timestamp}`, 'info');

        // Debug payload details
        console.log('📦 [EXT-DEBUG] UPLOAD_TRACKING payload details:');
        console.log('  - Batch ID:', payload?.batchId);
        console.log('  - Machine ID:', payload?.machineId);
        console.log('  - Shop ID:', payload?.shopId);
        console.log('  - Label:', payload?.label);
        console.log('  - Auto Generated:', payload?.autoGenerated);
        console.log('  - Reason:', payload?.reason);
        console.log('  - Requested By:', payload?.requestedBy);
        console.log('  - Timestamp:', payload?.timestamp);

        // Check machine ID match
        if (payload?.machineId && payload.machineId !== clientId) {
          console.warn('⚠️ [EXT-DEBUG] Machine ID mismatch!');
          console.warn('  - Task Machine ID:', payload.machineId);
          console.warn('  - Extension Machine ID:', clientId);
          console.warn('  - Skipping task...');
          debugLog('❌ [UPLOAD_TRACKING] Machine ID mismatch - skipping task', 'error');
          debugLog(`   Task Machine ID: ${payload.machineId}`, 'error');
          debugLog(`   Extension Machine ID: ${clientId}`, 'error');
          break;
        } else {
          console.log('✅ [EXT-DEBUG] Machine ID match confirmed');
          debugLog('✅ [UPLOAD_TRACKING] Machine ID match confirmed', 'success');
        }

        if (payload) {
          console.log(`🎯 [EXT-DEBUG] Task received: ${payload.reason} (autoGenerated: ${payload.autoGenerated})`);

          // Debug file info
          if (payload.file) {
            console.log('📄 [EXT-DEBUG] File details:');
            console.log('  - Filename:', payload.file.filename);
            console.log('  - Size:', payload.file.size, 'bytes');
            console.log('  - Content Type:', payload.file.contentType);
            console.log('  - Content length:', payload.file.content?.length);
            console.log('  - Content preview:', payload.file.content?.substring(0, 200) + '...');
          } else {
            console.error('❌ [EXT-DEBUG] No file in payload!');
            break;
          }

          // Debug upload params
          if (payload.uploadParams) {
            console.log('⚙️ [EXT-DEBUG] Upload params:');
            console.log('  - Carrier Code:', payload.uploadParams.carrierCode);
            console.log('  - Ship Method:', payload.uploadParams.shipMethod);
            console.log('  - Ship Date:', payload.uploadParams.shipDate);
          } else {
            console.error('❌ [EXT-DEBUG] No upload params in payload!');
          }

          // Debug tracking data
          if (payload.trackingData) {
            console.log('📊 [EXT-DEBUG] Tracking data:');
            console.log('  - Count:', payload.trackingData.length);
            console.log('  - Sample orders:', payload.trackingData.slice(0, 3).map(t => ({
              orderId: t.orderId,
              tracking: t.tracking,
              isFake: t.isFake,
              source: t.source
            })));
          }

          // Log task start
          console.log('📝 [EXT-DEBUG] Logging task start...');
          try {
            await postLogSingle({
              base,
              token: (await getCfg()).ingestToken,
              shopId,
              machineId: clientId,
              label: clientLabel,
              action: "auto",
              level: "info",
              message: `🎯 Starting UPLOAD_TRACKING task: ${payload.reason}`
            });
            console.log('✅ [EXT-DEBUG] Task start logged successfully');
          } catch (logError) {
            console.error('❌ [EXT-DEBUG] Failed to log task start:', logError);
          }

          const { file, uploadParams, trackingData } = payload;
          if (!file || typeof file.content !== "string" || !file.filename) {
            const error = new Error("UPLOAD_TRACKING payload.file is required");
            debugLog(`[UPLOAD_TRACKING] ${error.message}`, "error");
            if (payload?.batchId) {
              await reportAmazonFeedStatus({ batchId: payload.batchId, status: "failed", failureReason: error.message });
              error._uploadTrackingReported = true;
            }
            if (extensionLogger) {
              await extensionLogger.logTaskFailed({
                taskId: uploadTaskId,
                taskType: type,
                batchId: payload?.batchId,
                ordersCount: payload?.trackingData?.length || 0,
                filename: payload?.file?.filename
              }, error, "[UPLOAD_TRACKING] Upload tracking payload validation failed");
            }
            throw error;
          }

          // 1. File TXT đã sẵn sàng, không cần tạo
          console.log('📄 [EXT-DEBUG] Preparing file blob...');
          const blob = new Blob([file.content], { type: file.contentType });
          const fileObj = new File([blob], file.filename);
          console.log('✅ [EXT-DEBUG] File blob created:', {
            name: fileObj.name,
            size: fileObj.size,
            type: fileObj.type
          });

          // Log file preparation
          console.log('📝 [EXT-DEBUG] Logging file preparation...');
          try {
            await postLogSingle({
              base,
              token: (await getCfg()).ingestToken,
              shopId,
              machineId: clientId,
              label: clientLabel,
              action: "auto",
              level: "info",
              message: `📄 Prepared file: ${file.filename} (${file.content.length} bytes)`
            });
            console.log('✅ [EXT-DEBUG] File preparation logged successfully');
          } catch (logError) {
            console.error('❌ [EXT-DEBUG] Failed to log file preparation:', logError);
          }

          // 2. Upload lên platform ngay lập tức
          console.log('🚀 [EXT-DEBUG] Starting upload to Amazon...');
          console.log('📤 [EXT-DEBUG] Upload params:', uploadParams);

          const trackingUploadParams = {
            ...(uploadParams || {}),
            taskId: payload?.batchId || payload?.taskId || `upload_${Date.now()}`,
            batchId: payload?.batchId,
            ordersCount: trackingData?.length || uploadParams?.ordersCount || 0
          };

          try {
            const result = await withUploadTrackingLock("UPLOAD_TRACKING_SOCKET", async () => {
              const uploadResult = await uploadToAmazon(fileObj, trackingUploadParams);
              console.log(`[EXT-DEBUG] Successfully uploaded ${file.filename}`);
              console.log("[EXT-DEBUG] Native upload submitted; waiting for Amazon Processing Report...");
              const watch = {
                batchId: payload.batchId,
                taskId: serverTaskId,
                expectedRows: trackingData?.length || uploadParams?.ordersCount || 0,
                sellerCentralTabId: uploadResult?.dedicatedSellerCentralTabId || null,
                createdDedicatedTab: !!uploadResult?.dedicatedSellerCentralTabId,
                beforeBatchIds: uploadResult?.historyBeforeBatchIds || [],
                status: "submitted",
                createdAt: new Date().toISOString(),
              };
              await saveAmazonFeedWatch(watch);
              await reportAmazonFeedStatus({ batchId: payload.batchId, status: "submitted" });
              deferTaskCompletion = true;
              await pollAmazonFeedWatch(watch);

              if (extensionLogger) {
                const uploadEndTime = Date.now();
                await extensionLogger.logTaskProcessing({
                  taskId: uploadTaskId,
                  taskType: type,
                  batchId: payload?.batchId,
                  ordersCount: payload?.trackingData?.length || 0,
                  filename: payload?.file?.filename
                }, {
                  duration: uploadEndTime - uploadStartTime,
                  memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
                  cpuUsage: 0
                }, `[UPLOAD_TRACKING] Native upload submitted; waiting for Amazon Processing Report: ${file.filename}`);
              }

              return uploadResult;
            });

            if (result?.skipped) {
              throw new Error("Upload skipped because another upload is running");
            }

            console.log("[EXT-DEBUG] Upload completed");
            taskResult = {
              upload: {
                ok: true,
                batchId: payload.batchId,
                ordersCount: trackingData?.length || 0,
              },
            };
            break;
          } catch (error) {
            console.error(`[EXT-DEBUG] Failed to upload ${file.filename}:`, error);
            console.log("[EXT-DEBUG] Reporting failure to server...");

            if (payload?.batchId) {
              await reportAmazonFeedStatus({ batchId: payload.batchId, status: "failed", failureReason: error.message });
              error._uploadTrackingReported = true;
            }

            if (extensionLogger) {
              await extensionLogger.logTaskFailed({
                taskId: uploadTaskId,
                taskType: type,
                batchId: payload?.batchId,
                ordersCount: payload?.trackingData?.length || 0,
                filename: payload?.file?.filename
              }, error, `[UPLOAD_TRACKING] Upload tracking failed: ${file.filename}`);
            }

            throw error;
          }
        } else {
          console.log('⚠️ [EXT-DEBUG] Non-auto-generated UPLOAD_TRACKING task, skipping...');
        }
        break;

      default:
        console.log('❓ [EXT-DEBUG] Unknown task type:', type);
        break;
    }

    if (!deferTaskCompletion) {
      reportServerTask("completed", taskResult ? { result: taskResult } : {});
      log(`[TASK] Hoàn tất ${type || "UNKNOWN"} · ${serverTaskId}`);
    } else {
      log(`[TASK] Đã submit ${type || "UNKNOWN"}; chờ Amazon Processing Report · ${serverTaskId}`);
    }

  } catch (e) {
    reportServerTask("failed", { error: e?.message || String(e) });
    log(`[TASK] Lỗi ${type || "UNKNOWN"} · ${e?.message || "Unknown error"}`);
    console.error("❌ [EXT-DEBUG] Task processing error:", e?.message || e);
    console.error("📋 [EXT-DEBUG] Error stack:", e?.stack);
    console.error("📦 [EXT-DEBUG] Task that caused error:", { type, payload });

    // Report error for UPLOAD_TRACKING tasks
    if (type === "UPLOAD_TRACKING" && payload?.batchId && !e?._uploadTrackingReported) {
      console.log('📝 [EXT-DEBUG] Reporting task error to server...');
      try {
        await reportAmazonFeedStatus({ batchId: payload.batchId, status: "failed", failureReason: e?.message || "Unknown error" });
      } catch (reportError) {
        console.error('❌ [EXT-DEBUG] Failed to report error:', reportError);
      }
    }
    return { ok: false, error: e?.message || String(e) };
  }

  console.log('📨 [EXT-DEBUG] ===== END TASK PROCESSING =====\n');
}

// ====== Tự động connect khi extension khởi động (nếu autoConnect=true) ======
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[EXT-INSTALL] Extension installed/updated');
  await initializeLogger();
  if (extensionLogger) {
    await extensionLogger.logInfo('Extension installed or updated', {
      timestamp: new Date().toISOString(),
      event: 'onInstalled'
    });
  }

  const st = await chrome.storage.local.get(["autoConnect"]);
  if (st.autoConnect === undefined) {
    await chrome.storage.local.set({ autoConnect: true }); // bật mặc định
  }
  const s = await chrome.storage.local.get(["autoConnect"]);
  if (s.autoConnect !== false) {
    connectSocketIO(true); // force để chắc chắn kết nối lần đầu
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[EXT-STARTUP] Extension starting up...');
  await initializeLogger();
  if (extensionLogger) {
    await extensionLogger.logInfo('Extension startup initiated', {
      timestamp: new Date().toISOString(),
      event: 'onStartup'
    });
  }

  const st = await chrome.storage.local.get(["autoConnect"]);
  if (st.autoConnect !== false) {
    connectSocketIO(true); // force trên mỗi lần khởi động
  }
});

// ====== Tự reconnect khi đổi ingestUrl/shopId trong Options ======
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.ingestUrl || changes.shopId) {
    console.log('[EXT-CONFIG] Configuration changed, reconnecting socket...');
    if (extensionLogger) {
      await extensionLogger.logInfo('Configuration changed, reconnecting socket', {
        changes: Object.keys(changes),
        timestamp: new Date().toISOString()
      });
    }
    setTimeout(() => connectSocketIO(true), 300);
  }
});

/* ===============================
   DEBUG FUNCTIONS - Connection Diagnostics
   =============================== */

// Helper function để gửi log ra UI
function debugLog(message, level = 'info') {
  console.log(message); // Vẫn log console để backup
  persistRuntimeLog(message, level);

  // Gửi message tới popup để hiển thị
  chrome.runtime.sendMessage({
    type: 'DEBUG_LOG',
    payload: {
      message: message,
      level: level,
      timestamp: new Date().toLocaleTimeString()
    }
  }).catch(() => { }); // Ignore error nếu popup không mở
}

// Function to refresh Amazon session and CSRF token
async function refreshAmazonSession() {
  debugLog('🔄 [SESSION] Refreshing Amazon session...', 'info');

  try {
    // Visit main seller central page to refresh session
    const mainPageUrl = "https://sellercentral.amazon.com/";
    const mainResponse = await requestOnce(mainPageUrl, { method: 'GET' });

    if (mainResponse.ok) {
      debugLog('✅ [SESSION] Main page visited successfully', 'success');

      // Then visit feeds page to get fresh CSRF
      const feedsPageUrl = "https://sellercentral.amazon.com/order-reports-and-feeds/feeds";
      const feedsResponse = await requestOnce(feedsPageUrl, { method: 'GET' });

      if (feedsResponse.ok) {
        debugLog('✅ [SESSION] Feeds page visited successfully', 'success');
        return true;
      }
    }

    debugLog('❌ [SESSION] Failed to refresh session', 'error');
    return false;
  } catch (error) {
    debugLog(`❌ [SESSION] Session refresh error: ${error.message}`, 'error');
    return false;
  }
}

// Test CSRF token extraction from Amazon feeds page
async function testCSRFTokenExtraction() {
  debugLog('🔍 [CSRF-TEST] Testing CSRF token extraction...', 'info');

  try {
    // Visit the feeds page to get CSRF token
    const feedsPageUrl = "https://sellercentral.amazon.com/order-reports-and-feeds/feeds";
    debugLog(`📄 [CSRF-TEST] Fetching feeds page: ${feedsPageUrl}`, 'info');

    const feedsResponse = await requestOnce(feedsPageUrl, {
      method: 'GET'
    });

    if (!feedsResponse.ok) {
      debugLog(`❌ [CSRF-TEST] Failed to fetch feeds page: ${feedsResponse.status}`, 'error');
      return null;
    }

    const feedsHtml = await feedsResponse.text();
    debugLog(`📄 [CSRF-TEST] Page loaded, size: ${feedsHtml.length} chars`, 'info');

    // Extract CSRF token from the page HTML
    const csrfMatches = [
      /csrfToken['"]\s*:\s*['"]([^'"]+)['"]/i,
      /name=['"]csrfToken['"][^>]*value=['"]([^'"]+)['"]/i,
      /anti-csrftoken-a2z['"]\s*:\s*['"]([^'"]+)['"]/i,
      /"csrfToken"\s*:\s*"([^"]+)"/i,
      /window\.csrfToken\s*=\s*['"]([^'"]+)['"]/i,
      /data-csrf-token=['"]([^'"]+)['"]/i
    ];

    let csrfToken = null;
    for (let i = 0; i < csrfMatches.length; i++) {
      const regex = csrfMatches[i];
      const match = feedsHtml.match(regex);
      if (match && match[1]) {
        csrfToken = match[1];
        debugLog(`[CSRF-TEST] CSRF token found with pattern ${i + 1}: csrfIncluded=true csrfTokenLength=${csrfToken.length}`, 'success');
        break;
      } else {
        debugLog(`❌ [CSRF-TEST] Pattern ${i + 1} failed`, 'info');
      }
    }

    if (!csrfToken) {
      debugLog(`❌ [CSRF-TEST] No CSRF token found in page HTML`, 'error');

      // Try cookie fallback
      const cookieToken = await getCookie("https://sellercentral.amazon.com/", "anti-csrftoken-a2z");
      if (cookieToken) {
        debugLog(`[CSRF-TEST] Found CSRF token in cookie: cookieFound=true csrfTokenLength=${cookieToken.length}`, 'info');
        csrfToken = cookieToken;
      } else {
        debugLog(`❌ [CSRF-TEST] No CSRF token in cookie either`, 'error');
      }
    }

    // Test with a sample upload (dry run)
    if (csrfToken) {
      debugLog(`[CSRF-TEST] CSRF token ready for upload: csrfIncluded=true csrfTokenLength=${csrfToken.length}`, 'success');

      // Show what the FormData would look like
      debugLog(`📋 [CSRF-TEST] FormData would include:`, 'info');
      debugLog(`  - feedFile: [Binary File]`, 'info');
      debugLog(`  - feedName: confirmShipment`, 'info');
      debugLog(`  - feedVersion: new`, 'info');
      debugLog(`  - csrfToken: csrfIncluded=true csrfTokenLength=${csrfToken.length}`, 'info');
    }

    return csrfToken;

  } catch (error) {
    debugLog(`❌ [CSRF-TEST] Error during CSRF test: ${error.message}`, 'error');
    return null;
  }
}

// Code để debug connection - chỉ chạy khi cần
async function runExtensionDiagnostics() {
  debugLog('🔍 [EXT-DEBUG] Starting connection diagnostics...', 'info');

  // 1. Kiểm tra identity
  async function checkExtensionIdentity() {
    try {
      const identity = await getBaseShopAndIdentity();
      debugLog('🔑 [EXT-DEBUG] Extension Identity:', 'info');
      debugLog(`  - Base URL: ${identity.base}`, 'info');
      debugLog(`  - Shop ID: ${identity.shopId}`, 'info');
      debugLog(`  - Client ID (machineId): ${identity.clientId}`, 'info');
      debugLog(`  - Client Label: ${identity.clientLabel}`, 'info');

      // Kiểm tra match với test data
      const expectedMachineId = '6977178d9e8e7a4069e38170';
      const expectedShopId = '6977178d9e8e7a4069e38170';
      debugLog('🎯 [EXT-DEBUG] Identity Check:', 'info');
      debugLog(`  - Expected Machine ID: ${expectedMachineId}`, 'info');
      debugLog(`  - Actual Machine ID: ${identity.clientId}`, 'info');
      debugLog(`  - Machine ID Match: ${identity.clientId === expectedMachineId ? '✅' : '❌'}`,
        identity.clientId === expectedMachineId ? 'success' : 'error');
      debugLog(`  - Expected Shop ID: ${expectedShopId}`, 'info');
      debugLog(`  - Actual Shop ID: ${identity.shopId}`, 'info');
      debugLog(`  - Shop ID Match: ${identity.shopId === expectedShopId ? '✅' : '❌'}`,
        identity.shopId === expectedShopId ? 'success' : 'error');

      return identity;
    } catch (error) {
      debugLog(`❌ [EXT-DEBUG] Failed to get identity: ${error.message}`, 'error');
      return null;
    }
  }

  // 2. Kiểm tra Socket connection
  function checkSocketConnection() {
    debugLog('🔌 [EXT-DEBUG] Socket Connection Status:', 'info');
    debugLog(`  - Socket exists: ${!!socket}`, 'info');
    if (socket) {
      debugLog(`  - Socket connected: ${!!socket?.connected}`, socket?.connected ? 'success' : 'error');
      debugLog(`  - Socket ID: ${socket?.id || "NO_SOCKET"}`, 'info');
      debugLog(`  - Socket URL: ${socket.io?.uri}`, 'info');
      debugLog(`  - Socket transport: ${socket.io?.engine?.transport?.name}`, 'info');

      // Kiểm tra auth data
      if (socket.auth) {
        const expectedMachineId = '6977178d9e8e7a4069e38170';
        debugLog('🔑 [EXT-DEBUG] Socket Auth Check:', 'info');
        debugLog(`  - Auth Machine ID: ${socket.auth.machineId}`, 'info');
        debugLog(`  - Expected Machine ID: ${expectedMachineId}`, 'info');
        debugLog(`  - Auth Match: ${socket.auth.machineId === expectedMachineId ? '✅' : '❌'}`,
          socket.auth.machineId === expectedMachineId ? 'success' : 'error');
      }
    } else {
      debugLog('❌ [EXT-DEBUG] Socket not found! Extension not connected.', 'error');
    }
  }

  // 3. Test server room check
  async function checkServerRooms(identity) {
    try {
      debugLog('🏠 [EXT-DEBUG] Checking server rooms...', 'info');
      const response = await fetch(`${identity.base}/api/shipping-batch/debug/socket-rooms?machineId=${identity.clientId}`);
      const data = await response.json();

      debugLog(`  - Total sockets on server: ${data.totalSockets}`, 'info');
      debugLog(`  - My room socket count: ${data.roomInfo?.socketCount || 0}`, 'info');

      if (data.roomInfo?.socketCount === 0) {
        debugLog('❌ [EXT-DEBUG] Extension not found in server room!', 'error');
        debugLog('💡 [EXT-DEBUG] Possible issues:', 'error');
        debugLog('  - Extension not connected to server', 'error');
        debugLog('  - Wrong machineId in auth data', 'error');
        debugLog('  - Socket middleware error', 'error');
      } else {
        debugLog('✅ [EXT-DEBUG] Extension found in server room', 'success');
        data.roomInfo.sockets.forEach((sock, index) => {
          debugLog(`  Socket ${index + 1}: ${sock.socketId} (${sock.machineId})`, 'info');
        });
      }

      return data;
    } catch (error) {
      debugLog(`❌ [EXT-DEBUG] Failed to check server rooms: ${error.message}`, 'error');
      return null;
    }
  }

  // 4. Test task listener
  function checkTaskListener() {
    debugLog('👂 [EXT-DEBUG] Checking task listeners...', 'info');
    if (socket) {
      const listeners = socket.listeners('server:task');
      debugLog(`  - server:task listeners: ${listeners.length}`, 'info');
      if (listeners.length === 0) {
        debugLog('❌ [EXT-DEBUG] No server:task listeners found!', 'error');
        debugLog('💡 [EXT-DEBUG] Extension is not listening for tasks', 'error');
      } else {
        debugLog('✅ [EXT-DEBUG] Task listeners found', 'success');
      }
    }
  }

  // 5. Test create batch
  async function testCreateBatch(identity) {
    try {
      debugLog('🧪 [EXT-DEBUG] Testing batch creation...', 'info');
      const response = await fetch(`${identity.base}/api/shipping-batch/create-from-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: identity.clientId,
          orders: [{
            orderId: '111-6132493-9725004',
            shopId: identity.shopId
          }],
          label: 'Extension Debug Test',
          autoUpload: true
        })
      });

      const data = await response.json();
      debugLog('📦 [EXT-DEBUG] Batch creation result:', 'info');
      debugLog(`  - Success: ${data.ok}`, data.ok ? 'success' : 'error');
      debugLog(`  - Batches created: ${data.successfulBatches}`, 'info');

      if (data.batches) {
        data.batches.forEach(batch => {
          debugLog(`  - Batch ID: ${batch.batchId}`, 'info');
          debugLog(`  - Auto task sent: ${batch.autoTaskSent}`, batch.autoTaskSent ? 'success' : 'error');
          debugLog(`  - Orders: ${batch.totalOrders} (${batch.totalReal} real, ${batch.totalFake} fake)`, 'info');
        });
      }

      return data;
    } catch (error) {
      debugLog(`❌ [EXT-DEBUG] Batch creation failed: ${error.message}`, 'error');
      return null;
    }
  }

  // Chạy tất cả tests
  debugLog('🚀 [EXT-DEBUG] ===== FULL DIAGNOSTICS =====', 'info');

  // Step 1: Check identity
  const identity = await checkExtensionIdentity();
  if (!identity) return;

  // Step 2: Check socket
  checkSocketConnection();

  // Step 3: Check task listener
  checkTaskListener();

  // Step 4: Check server rooms
  await checkServerRooms(identity);

  // Step 5: Test batch creation
  debugLog('🧪 [EXT-DEBUG] Testing batch creation (should trigger task)...', 'info');
  await testCreateBatch(identity);

  debugLog('⏰ [EXT-DEBUG] Waiting 5 seconds for task...', 'info');
  setTimeout(() => {
    debugLog('⏰ [EXT-DEBUG] If no task received above, there is a connection issue', 'error');
  }, 5000);

  debugLog('🚀 [EXT-DEBUG] ===== DIAGNOSTICS COMPLETE =====', 'success');
}

/* ========== Test Connection API ========== */

// Report connection status via extensionLogger only
async function testConnection() {
  try {
    const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();

    if (!base || !clientId) {
      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('config_check_failed', {
          reason: 'missing_config',
          base: !!base,
          clientId: !!clientId
        }, 'Connection status check failed: Missing configuration');
      }
      return { ok: false, reason: 'missing_config' };
    }

    // Chỉ báo cáo trạng thái socket hiện tại, không gọi API
    const socketStatus = socket?.connected ? 'connected' : 'disconnected';
    const socketId = socket?.id || null;

    if (extensionLogger) {
      await extensionLogger.logConnectionStatus(socketStatus, {
        socketId,
        machineId: clientId,
        timestamp: new Date().toISOString(),
        socketExists: !!socket
      }, `Connection status report: Socket ${socketStatus}`);
    }

    return {
      ok: socket?.connected || false,
      socketStatus,
      socketId,
      machineId: clientId
    };

  } catch (error) {
    if (extensionLogger) {
      await extensionLogger.logConnectionStatus('status_check_error', {
        errorMessage: error.message,
        errorStack: error.stack
      }, `Connection status check error: ${error.message}`);
    }

    return { ok: false, error: error.message };
  }
}

const LEGACY_AUTO_CONFIG_ALARMS = [
  "AUTO_CFG_IMPORT_ORDER",
  "AUTO_CFG_IMPORT_FBM",
  "AUTO_CFG_IMPORT_ADS",
  "AUTO_CFG_UPLOAD_TRACKING",
  "AUTO_CFG_SYNC",
];

async function clearLegacyAutoConfigAlarms() {
  await Promise.all(LEGACY_AUTO_CONFIG_ALARMS.map((name) => chrome.alarms.clear(name)));
}

// Kiểm tra reconnect nền mỗi 10 phút.
function startAutoReconnectPolling() {
  // Dừng polling cũ nếu có
  stopAutoReconnectPolling();

  // Socket khỏe không cần ghi log; chỉ ghi khi thực sự phải reconnect hoặc lỗi.
  autoReconnectInterval = setInterval(async () => {
    try {
      const { autoConnect } = await chrome.storage.local.get(['autoConnect']);

      // Chỉ auto reconnect nếu autoConnect được bật
      if (autoConnect !== false) {
        // Nếu socket không tồn tại hoặc không connected, thử kết nối lại
        if (!socket || !socket.connected) {
          if (extensionLogger) {
            await extensionLogger.logInfo('Auto reconnect triggered - socket disconnected', {
              socketExists: !!socket,
              socketConnected: socket?.connected || false
            });
          }

          await connectSocketIO(true); // Force reconnect
        }
      }
    } catch (error) {
      if (extensionLogger) {
        await extensionLogger.logError(error, {
          context: 'auto_reconnect_polling'
        }, 'Auto reconnect polling error');
      }
    }
  }, 600000); // 10 phút
}

// Dừng auto reconnect polling
function stopAutoReconnectPolling() {
  if (autoReconnectInterval) {
    safeLogInfo('Auto reconnect polling stopped');
    clearInterval(autoReconnectInterval);
    autoReconnectInterval = null;
  }
}

// Expose debug function globally
globalThis.runExtensionDiagnostics = runExtensionDiagnostics;
globalThis.testConnection = testConnection;
globalThis.startAutoReconnectPolling = startAutoReconnectPolling;
globalThis.stopAutoReconnectPolling = stopAutoReconnectPolling;
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PING") return sendResponse({ ok: true });

      if (msg?.type === "PERSIST_RUNTIME_LOG") {
        persistRuntimeLog(msg.payload?.message, msg.payload?.level);
        return sendResponse({ ok: true });
      }

      if (msg?.type === "CLEAR_RUNTIME_LOG") {
        await chrome.storage.local.remove(RUNTIME_LOG_STORAGE_KEY);
        return sendResponse({ ok: true });
      }

      if (msg?.type === "GET_LAST_UPLOAD_TRACKING_FINAL_TSV") {
        const data = await chrome.storage.local.get(["lastUploadTrackingFinalTsv"]);
        const item = data.lastUploadTrackingFinalTsv || {};
        return sendResponse({
          ok: !!item.content,
          batchId: item.batchId || null,
          filename: item.filename || "",
          rows: item.rows || 0,
          tsvLength: item.tsvLength || 0,
          tsvChecksum: item.tsvChecksum || "",
          contentJsonPreview: item.contentJsonPreview || "",
          lineBreakAudit: item.lineBreakAudit || null,
          content: item.content || ""
        });
      }

      if (msg?.type === "DOWNLOAD_LAST_UPLOAD_TRACKING_FINAL_TSV") {
        const data = await chrome.storage.local.get(["lastUploadTrackingFinalTsv"]);
        const item = data.lastUploadTrackingFinalTsv || {};
        if (!item.content) return sendResponse({ ok: false, error: "No final TSV snapshot found" });
        if (!chrome.downloads?.download) {
          return sendResponse({
            ok: false,
            error: "downloads permission is not enabled for this extension",
            batchId: item.batchId || null,
            filename: item.filename || "",
            rows: item.rows || 0,
            tsvLength: item.tsvLength || 0,
            tsvChecksum: item.tsvChecksum || ""
          });
        }

        const batchId = String(item.batchId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
        let method = "dataUrl";
        let url = "data:text/plain;charset=utf-8," + encodeURIComponent(item.content);
        if (typeof URL?.createObjectURL === "function" && typeof Blob !== "undefined") {
          try {
            url = URL.createObjectURL(new Blob([item.content], { type: "text/plain;charset=utf-8" }));
            method = "blobUrl";
          } catch {
            url = "data:text/plain;charset=utf-8," + encodeURIComponent(item.content);
            method = "dataUrl";
          }
        }
        const downloadId = await chrome.downloads.download({
          url,
          filename: `debug-final-upload-tracking-${batchId}.txt`,
          saveAs: true
        });
        if (method === "blobUrl") setTimeout(() => URL.revokeObjectURL(url), 30000);
        return sendResponse({ ok: true, downloadId, method });
      }

      if (msg?.type === "UPLOADFEED_CSRF_CAPTURED") {
        const result = await saveUploadFeedCsrfTokenCapture(msg.payload || {});
        return sendResponse({ ok: true, saved: !!result?.ok, source: result?.source, tokenLength: result?.tokenLength });
      }

      if (msg?.type === "UPLOADFEED_SNIFFER_DEBUG") {
        const payload = msg.payload || {};
        logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed sniffer debug", {
          event: payload.event || "",
          href: payload.href || "",
          title: payload.title || "",
          installedAt: payload.installedAt || 0,
        }, "info");
        return sendResponse({ ok: true });
      }

      if (msg?.type === "INSTALL_UPLOADFEED_CSRF_SNIFFER") {
        const tab = await findOrOpenSellerCentralFeedsTab();
        if (!tab?.id) return sendResponse({ ok: false, error: "Unable to open Seller Central feeds tab" });
        await waitForSellerCentralTabComplete(tab.id);
        await delayMs(1000);
        await installUploadFeedCsrfSniffer(tab.id);
        logUploadTrackingDiagnostic("[UPLOAD_TRACKING] uploadFeed CSRF sniffer installed by debug command", {
          tabId: tab.id,
          message: "Sniffer installed. Perform one manual Seller Central upload to capture csrfToken.",
        }, "success");
        return sendResponse({
          ok: true,
          tabId: tab.id,
          message: "Sniffer installed. Perform one manual Seller Central upload to capture csrfToken.",
        });
      }

      if (msg?.type === "VERIFY_UPLOADFEED_SNIFFER") {
        const tab = await findOrOpenSellerCentralFeedsTab();
        if (!tab?.id) return sendResponse({ ok: false, error: "Unable to open Seller Central feeds tab" });
        await waitForSellerCentralTabComplete(tab.id);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => ({
            mainWorldFlag: !!window.__APO_UPLOADFEED_SNIFFER_INSTALLED__,
            installedAt: window.__APO_UPLOADFEED_SNIFFER_INSTALLED_AT__ || 0,
            href: location.href,
            title: document.title,
            fetchPatched: !!window.fetch?.__apoUploadFeedPatched,
            requestPatched: !!window.Request?.__apoUploadFeedPatched,
            xhrPatched: !!XMLHttpRequest.prototype.send?.__apoUploadFeedPatched,
            formDataAppendPatched: !!FormData.prototype.append?.__apoUploadFeedPatched,
            formDataSetPatched: !!FormData.prototype.set?.__apoUploadFeedPatched,
            consoleLogPatched: !!console.log?.__apoUploadFeedPatched,
          }),
        });
        return sendResponse({ ok: true, tabId: tab.id, ...(res?.result || {}) });
      }

      if (msg?.type === "TEST_UPLOADFEED_SNIFFER_CAPTURE") {
        const tab = await findOrOpenSellerCentralFeedsTab();
        if (!tab?.id) return sendResponse({ ok: false, error: "Unable to open Seller Central feeds tab" });
        await waitForSellerCentralTabComplete(tab.id);
        await installUploadFeedCsrfSniffer(tab.id);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const fakeToken = "A".repeat(104);
            console.log("dispatching", {
              type: "UPLOAD_ACTION",
              feedTypeName: "confirmShipment",
              __apoTestToken: true,
              payload: { csrfToken: fakeToken },
            });
            return {
              ok: true,
              tokenLength: fakeToken.length,
              href: location.href,
              title: document.title,
            };
          },
        });
        await delayMs(500);
        const data = await chrome.storage.local.get([AMAZON_UPLOADFEED_CSRF_CACHE_KEY]);
        const cache = data[AMAZON_UPLOADFEED_CSRF_CACHE_KEY] || null;
        return sendResponse({
          ok: true,
          tabId: tab.id,
          injected: res?.result || {},
          cache: {
            tokenFound: !!cache?.token,
            tokenLength: cache?.tokenLength || 0,
            source: cache?.source || null,
            isTestToken: !!cache?.isTestToken,
            valid: !!cache?.token && isValidUploadFeedCsrfToken(cache.token),
          },
        });
      }

      if (msg?.type === "GET_UPLOADFEED_READINESS_STATUS") {
        return sendResponse(await getUploadFeedReadinessStatus(msg.options || {}));
      }

      if (msg?.type === "CHECK_UPLOADFEED_CSRF_CACHE") {
        const cacheStatus = await getUploadFeedCsrfCacheStatus();
        return sendResponse({
          ok: true,
          tokenFound: cacheStatus.tokenFound,
          tokenLength: cacheStatus.tokenLength,
          source: cacheStatus.source,
          ageMs: cacheStatus.ageMs,
          ageMin: cacheStatus.ageMin,
          isTestToken: cacheStatus.isTestToken,
          valid: cacheStatus.valid,
        });
      }

      if (msg?.type === "CLEAR_UPLOADFEED_CSRF_CACHE") {
        return sendResponse(await clearUploadFeedCsrfCache("manual_debug"));
      }

      if (msg?.type === "SOCKET_RESET_BUSY") {
        connectBusy = false;
        try {
          if (socket) socket.disconnect();
        } catch { }
        socket = null;
        stopHeartbeat();
        return sendResponse({ ok: true });
      }

      if (msg.type === "ADS_BRIDGE_LOG") {
        const { level, message, rawData } = msg.payload || {};
        if (!extensionLogger) await initializeLogger();
        if (extensionLogger) {
          if (level === "error") {
            await extensionLogger.logError({ message, code: "ADS_BRIDGE" }, rawData || {}, message);
          } else {
            await extensionLogger.logInfo(message, rawData || {});
          }
        }
        return sendResponse({ ok: true });
      }

      if (msg.type === "RUN_ADS_SPEND") {
        const range = { startDate: msg.payload?.startDate, endDate: msg.payload?.endDate };
        const result = await runExportAdsSpendRange(range.startDate, range.endDate, { foreground: true });
        await persistManualAdsResult("import", range, result);
        return sendResponse(result);
      }

      if (msg.type === "DRY_RUN_ADS_SPEND") {
        const range = { startDate: msg.payload?.startDate, endDate: msg.payload?.endDate };
        const result = await runExportAdsSpendRange(range.startDate, range.endDate, { dryRun: true, foreground: true });
        await persistManualAdsResult("dry-run", range, result);
        return sendResponse(result);
      }

      if (msg.type === "PREVIEW_ADS_SPEND") {
        const range = { startDate: msg.payload?.startDate, endDate: msg.payload?.endDate };
        const result = await previewAdsSpendRange(range.startDate, range.endDate);
        await persistManualAdsResult("preview", range, result);
        return sendResponse(result);
      }

      // Manual full flow (CLICK) — emit log qua socket
      if (msg.type === "AUTO_RUN_NOW")
        return sendResponse(await runImportOrdersOnce("click"));

      if (msg?.type === "SOCKET_CONNECT") {
        const r = await connectSocketIO(true); // force reconnect
        sendResponse(r);
        return;
      }
      if (msg?.type === "SOCKET_SET_AUTOCONNECT") {
        await chrome.storage.local.set({ autoConnect: !!msg.enabled });
        sendResponse({ ok: true, enabled: !!msg.enabled });
        return;
      }

      if (msg?.type === "RUN_DIAGNOSTICS") {
        runExtensionDiagnostics();
        return sendResponse({ ok: true, message: "Diagnostics started, check console" });
      }

      if (msg?.type === "OPEN_AMAZON_SC") {
        // Open Amazon Seller Central to get cookies
        debugLog('🌐 [AMAZON] Opening Amazon Seller Central...', 'info');

        chrome.tabs.create({
          url: "https://sellercentral.amazon.com/order-reports-and-feeds/reports",
          active: true
        }, (tab) => {
          if (chrome.runtime.lastError) {
            debugLog(`❌ [AMAZON] Failed to open Amazon SC: ${chrome.runtime.lastError.message}`, 'error');
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            debugLog('✅ [AMAZON] Amazon Seller Central opened successfully', 'success');
            debugLog('💡 [AMAZON] Please login and then test upload again', 'info');
            sendResponse({ ok: true, message: "Amazon Seller Central opened", tabId: tab.id });
          }
        });
        return true; // Keep message channel open for async response
      }

      if (msg?.type === "CHECK_AMAZON_COOKIES") {
        // Check Amazon cookies
        const cookies = {};
        try {
          cookies.csrfA2z = await getCookie("https://sellercentral.amazon.com/", "anti-csrftoken-a2z");
          cookies.sessionId = await getCookie("https://sellercentral.amazon.com/", "session-id");
          cookies.sessionToken = await getCookie("https://sellercentral.amazon.com/", "session-token");
          cookies.ubidMain = await getCookie("https://sellercentral.amazon.com/", "ubid-main");

          debugLog('🍪 [COOKIES] Amazon Cookies Check:', 'info');
          debugLog(`  - anti-csrftoken-a2z: ${cookies.csrfA2z ? 'Found' : 'Missing'}`, cookies.csrfA2z ? 'success' : 'error');
          debugLog(`  - session-id: ${cookies.sessionId ? 'Found' : 'Missing'}`, cookies.sessionId ? 'success' : 'error');
          debugLog(`  - session-token: ${cookies.sessionToken ? 'Found' : 'Missing'}`, cookies.sessionToken ? 'success' : 'error');
          debugLog(`  - ubid-main: ${cookies.ubidMain ? 'Found' : 'Missing'}`, cookies.ubidMain ? 'success' : 'error');

          if (!cookies.csrfA2z) {
            debugLog('❌ [COOKIES] No CSRF token found - please login to Amazon Seller Central', 'error');
          } else if (!cookies.sessionId) {
            debugLog('❌ [COOKIES] No session found - please login to Amazon Seller Central', 'error');
          } else {
            debugLog('✅ [COOKIES] Amazon authentication looks good', 'success');
          }

          return sendResponse({
            ok: true,
            cookies: Object.fromEntries(Object.entries(cookies).map(([key, value]) => [key, !!value]))
          });
        } catch (error) {
          debugLog(`❌ [COOKIES] Error checking cookies: ${error.message}`, 'error');
          return sendResponse({ ok: false, error: error.message });
        }
      }

      if (msg?.type === "TEST_CSRF_EXTRACTION") {
        // Test CSRF token extraction
        debugLog('🧪 [TEST] Starting CSRF token extraction test...', 'info');

        try {
          const csrfToken = await testCSRFTokenExtraction();
          return sendResponse({
            ok: true,
            csrfIncluded: !!csrfToken,
            csrfTokenLength: String(csrfToken || "").length,
            message: csrfToken ? 'CSRF token extracted successfully' : 'No CSRF token found'
          });
        } catch (error) {
          debugLog(`❌ [TEST] CSRF extraction test failed: ${error.message}`, 'error');
          return sendResponse({ ok: false, error: error.message });
        }
      }

      if (msg?.type === "TEST_UPLOAD_WITH_TOKEN") {
        // Test upload với CSRF token thủ công
        const { csrfToken } = msg.payload || {};

        if (!csrfToken) {
          debugLog('❌ [TEST] No CSRF token provided', 'error');
          return sendResponse({ ok: false, error: "CSRF token required" });
        }

        debugLog(`[TEST] Testing upload with manual CSRF token: csrfIncluded=true csrfTokenLength=${String(csrfToken || "").length}`, 'info');

        const testTask = {
          type: 'UPLOAD_TRACKING',
          payload: {
            autoGenerated: true,
            reason: 'Manual test with CSRF token',
            batchId: 'test_manual_' + Date.now(),
            file: {
              content: 'order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n113-6500150-8449038\t2026-04-06T00:22:22+00:00\tUSPS\t9400136105660294358530\tUSPS First Class\n',
              filename: 'test_manual_csrf.txt',
              contentType: 'text/tab-separated-values; charset=utf-8'
            },
            uploadParams: {
              csrfToken: csrfToken,
              carrierCode: 'USPS',
              shipMethod: 'USPS First Class',
              shipDate: '2026-04-06T00:22:22+00:00'
            }
          }
        };

        const { payload } = testTask;

        if (payload) {
          const { file, uploadParams } = payload;
          const blob = new Blob([file.content], { type: file.contentType });
          const fileObj = new File([blob], file.filename);

          try {
            const result = await withUploadTrackingLock("UPLOAD_TRACKING_TEST_TOKEN", async () => {
              return uploadToAmazon(fileObj, uploadParams);
            });
            if (result?.skipped) {
              debugLog("[UPLOAD_TRACKING] Manual CSRF test skipped because another upload is running", "info");
              return sendResponse(result);
            }
            debugLog("Manual CSRF test successful!", "success");
            return sendResponse({ ok: true, message: "Manual CSRF test successful", result });
          } catch (error) {
            debugLog(`Manual CSRF test failed: ${error.message}`, "error");
            return sendResponse({ ok: false, error: error.message });
          }
        }

        return sendResponse({ ok: false, error: "Missing upload payload" });
      }

      if (msg?.type === "TEST_CONNECTION") {
        // Test connection thủ công
        const result = await testConnection();
        return sendResponse(result);
      }

      if (msg?.type === "START_AUTO_RECONNECT") {
        // Bắt đầu auto reconnect polling thủ công
        startAutoReconnectPolling();
        return sendResponse({ ok: true, message: "Auto reconnect polling started" });
      }

      if (msg?.type === "STOP_AUTO_RECONNECT") {
        // Dừng auto reconnect polling thủ công
        stopAutoReconnectPolling();
        return sendResponse({ ok: true, message: "Auto reconnect polling stopped" });
      }

      if (msg?.type === "TEST_UPLOAD_TRACKING") {
        // Test manual upload tracking task
        const testTask = {
          type: 'UPLOAD_TRACKING',
          payload: {
            autoGenerated: true,
            reason: 'Manual test from extension',
            batchId: 'test_' + Date.now(),
            file: {
              content: 'order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n113-6500150-8449038\t2026-04-06T00:22:22+00:00\tUSPS\t9400136105660294358530\tUSPS First Class\n',
              filename: 'test_tracking_upload.txt',
              contentType: 'text/tab-separated-values; charset=utf-8'
            },
            uploadParams: {
              carrierCode: 'USPS',
              shipMethod: 'USPS First Class',
              shipDate: '2026-04-06T00:22:22+00:00'
            },
            trackingData: [{
              orderId: '113-6500150-8449038',
              tracking: '9400136105660294358530',
              isFake: false,
              source: 'test'
            }]
          }
        };

        // Simulate task reception
        debugLog('🧪 [TEST] Simulating UPLOAD_TRACKING task...', 'info');

        const result = await handleServerTask(testTask);
        if (result?.skipped) {
          return sendResponse(result);
        }
        return sendResponse({ ok: true, message: "Test upload task completed", result });
      }

      sendResponse({ ok: false, message: "Unknown command" });
    } catch (e) {
      sendResponse({ ok: false, message: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SOCKET_RECONNECT_ALARM) {
    reconnectSocketIfNeeded("alarm").catch((error) => {
      safeLogConnectionStatus("reconnect_failed", { source: "alarm", error: error?.message }, `Socket alarm reconnect failed: ${error?.message || error}`);
    });
  }
  if (alarm.name === AMAZON_FEED_WATCH_ALARM) pollAmazonFeedWatches();
});

// ── Khởi động tự động khi background script load ──
// Không phụ thuộc socket, chỉ cần có shopId và ingestUrl
(async () => {
  try {
    await clearLegacyAutoConfigAlarms();
    ensureSocketReconnectAlarm();
    await ensureAmazonFeedWatchAlarm();
    await reconnectSocketIfNeeded("service_worker_start");
    await pollAmazonFeedWatches();
    debugLog("✅ [INIT] Legacy extension schedules cleared; waiting for backend tasks", "success");
  } catch (e) {
    debugLog(`❌ [INIT] Could not clear legacy schedules: ${e.message}`, "error");
  }
})();
