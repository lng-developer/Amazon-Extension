/* Amazon order, ads, transaction, settlement imports and LNG command polling. */
import { DEFAULT_ENVIRONMENTS, deriveApiUrls, resolveDevelopmentApiUrl } from "./config.js";
import { pollExtensionCommand, queueAdsSpendCommand, queueOrderImportCommand } from "./extensionCommandClient.js";
import { postFileTo, postOrderImport } from "./backendApi.js";
import { createExtensionLogger } from "./extensionLogger.js";
import { ORDER_IMPORT_PROGRESS_KEY, createOrderImportProgress } from './orderImportProgress.js';
import { parseTSV } from './orderReportParser.js';
import {
  buildOneOffReportConfig,
  findCsvReportTemplate,
  isTerminalReportStatus,
  REPORT_POLL_INTERVAL_MS,
  reportConfigurationId,
  shouldFailReportStatus,
} from './adsReporting.js';
import { classifyAmazonAdsReportLink, createGmailAdsDownloadFingerprint } from './gmailReportDownload.js';
import { fetchTransactionsCsv as fetchAmazonTransactionsCsv } from './amazonTransaction.js';
const REPORT_POLL_MAX_ATTEMPTS = 18;
const ADS_LOCK_STALE_MS = 5 * 60 * 1000;
const EXTENSION_COMMAND_POLL_ALARM = "EXTENSION_COMMAND_POLL";
const EXTENSION_COMMAND_POLL_BACKOFF_KEY = "extensionCommandPollBackoff";
const EXTENSION_CONNECTION_STATUS_KEY = "extensionConnectionStatus";
const EXTENSION_COMMAND_POLL_BACKOFF_MINUTES = [1, 2, 5, 10];
const adsApiLock = { running: false, taskName: "", runId: "", startedAt: 0 };
const extensionLogger = createExtensionLogger({ storage: chrome.storage.local });
async function setOrderImportProgress(state, message, details = {}) {
  await chrome.storage.local.set({ [ORDER_IMPORT_PROGRESS_KEY]: createOrderImportProgress(state, message, details) });
}
const log = (message, context) => void extensionLogger.logInfo(message, context);
const debugLog = (message, level = "info") =>
  void (level === "error" ? extensionLogger.logError(null, undefined, message) : extensionLogger.logInfo(message));
async function initializeLogger() { return extensionLogger; }
const SC_BASE = "https://sellercentral.amazon.com";
const ADS_BASE = "https://advertising.amazon.com";
const ADS_RETRIEVE_URL = "https://advertising.amazon.com/a9g-api-gateway/cm/dds/retrieveReport";
/* ---------- Amazon Ads Auth Hardening ---------- */
const ADS_HEADER_STORAGE_KEYS = [
  "adsAccountId",
  "adsAdvertiserId",
  "adsClientId",
  "adsMarketplaceId",
  "adsCsrfData",
  "adsCsrfToken",
  "adsReportingCsrfToken",
  "adsHeaderLastSeen",
];
const ADS_HEADER_REFRESH_TIMEOUT_MS = 25 * 1000;
const ADS_TAB_LOAD_TIMEOUT_MS = 35 * 1000;
const ADS_PAGE_SETTLE_MS = 3500;
const GMAIL_ADS_RECENT_DOWNLOADS_KEY = 'gmailAdsRecentDownloads';
const GMAIL_ADS_RECENT_DOWNLOADS_TTL_MS = 24 * 60 * 60 * 1000;
const GMAIL_ADS_MAX_FILE_SIZE = 20 * 1024 * 1024;

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createAdsError(message, status = 0, responseText = "") { const error = new Error(message); error.status = status; error.responseText = responseText; return error; }
function isAdsAuthError(error) { return [401, 403].includes(Number(error?.status)) || /sign.?in|login|unauthor/i.test(String(error?.responseText || error?.message || "")); }
async function waitForAdsTabComplete(tabId) {
  if ((await chrome.tabs.get(tabId)).status === "complete") return;
  await new Promise((resolve, reject) => {
    const onUpdated = (updatedTabId, changeInfo) => { if (updatedTabId === tabId && changeInfo.status === "complete") { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } };
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error("Amazon Ads page did not finish loading")); }, ADS_TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
async function clearAdsHeaders() { await chrome.storage.local.remove([...ADS_HEADER_STORAGE_KEYS, "adsCandidateHeaders"]); }

async function reloadAdsTabForHeaderCapture(tabId) {
  const injected = new Promise((resolve, reject) => {
    let handled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onUpdated = async (updatedTabId, changeInfo) => {
      if (handled || updatedTabId !== tabId || changeInfo.status !== "loading") return;
      handled = true;
      cleanup();
      try {
        await ensureAdsBridgeInjected(tabId);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Amazon Ads page did not start reloading"));
    }, ADS_HEADER_REFRESH_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  await chrome.tabs.reload(tabId);
  await injected;
}

async function forceRefreshAdsHeaders({ reporting = false } = {}) {
  const tabId = await (reporting ? ensureAdsReportingTab() : ensureAdsTab());
  await reloadAdsTabForHeaderCapture(tabId);
  let headers;
  if (reporting) {
    headers = await waitForAdsReportingHeaders();
  } else {
    await waitForAdsTabComplete(tabId);
    await delayMs(ADS_PAGE_SETTLE_MS);
    const state = await chrome.storage.local.get([...ADS_HEADER_STORAGE_KEYS, "adsCandidateHeaders"]);
    headers = { ...(state.adsCandidateHeaders || {}), ...state };
  }
  if (!(reporting ? hasAdsReportingHeaders(headers) : isAdsHeaderComplete(headers))) {
    throw createAdsError(
      reporting
        ? "Amazon Ads Reporting CSRF token was not observed. Reload the extension, then retry once."
        : "Amazon Ads headers are unavailable. Sign in to advertising.amazon.com and open the campaign page.",
      401,
    );
  }
  await chrome.storage.local.set(Object.fromEntries(ADS_HEADER_STORAGE_KEYS.map((key) => [key, headers[key]])));
}
async function ensureFreshAdsHeaders() {
  const state = await readAdsHeaderState();
  if (isAdsHeaderComplete(state)) return;
  await forceRefreshAdsHeaders();
}

async function ensureFreshAdsReportingHeaders() {
  const state = await readAdsHeaderState();
  if (hasAdsReportingHeaders(state)) return;
  await forceRefreshAdsHeaders({ reporting: true });
}

function hasAdsReportingHeaders(st = {}) {
  return !!st.adsReportingCsrfToken;
}

async function waitForAdsReportingHeaders() {
  const expiresAt = Date.now() + ADS_HEADER_REFRESH_TIMEOUT_MS;
  let state = {};
  do {
    state = await chrome.storage.local.get([...ADS_HEADER_STORAGE_KEYS, "adsCandidateHeaders"]);
    const headers = { ...(state.adsCandidateHeaders || {}), ...state };
    if (hasAdsReportingHeaders(headers)) return headers;
    await delayMs(500);
  } while (Date.now() < expiresAt);
  return { ...(state.adsCandidateHeaders || {}), ...state };
}

function isAdsHeaderComplete(st = {}) {
  return !!(
    st.adsAccountId &&
    st.adsAdvertiserId &&
    st.adsClientId &&
    st.adsMarketplaceId &&
    st.adsCsrfData &&
    st.adsCsrfToken &&
    st.adsReportingCsrfToken
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

async function getCookie(url, name) { const cookie = await chrome.cookies.get({ url, name }); return cookie?.value || ""; }
async function amazonHeaders() { const a2z = await getCookie(`${SC_BASE}/`, "anti-csrftoken-a2z"); return { accept: "*/*", origin: SC_BASE, referer: `${SC_BASE}/order-reports-and-feeds/feeds`, ...(a2z ? { "anti-csrftoken-a2z": a2z } : {}) }; }
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
  const headers = { ...(await amazonHeaders()), ...(init.headers || {}) };
  return fetch(url, {
    credentials: "include",
    ...init,
    headers,
  });
}

/* ---------- Storage / URLs ---------- */
async function getCfg(keys = []) {
  const all = await chrome.storage.local.get([
    "ingestUrl",
    "ingestToken",
    "marketplaceCode",
    "activeEnvironment",
    "ingestEnvironments",
    "refNewOrders",
    "refAllOrders",
    // Ads headers (tự động cập nhật)
    "adsAccountId",
    "adsAdvertiserId",
    "adsClientId",
    "adsMarketplaceId",
    "adsCsrfData",
    "adsCsrfToken",
    "adsReportingCsrfToken",
    "adsHeaderLastSeen",
    // Auto
    "autoEnabled",
    "autoUpload_enabled", "autoUpload_interval",
    ...keys,
  ]);
  const environment = "development";
  const environmentConfig = all.ingestEnvironments?.[environment];
  if (environmentConfig) {
    all.ingestUrl = environmentConfig.ingestUrl || all.ingestUrl;
    all.ingestToken = environmentConfig.ingestToken || all.ingestToken;
    all.marketplaceCode = environmentConfig.marketplaceCode || all.marketplaceCode;
  }
  all.ingestUrl = resolveDevelopmentApiUrl(all.ingestUrl);
  all.marketplaceCode = (all.marketplaceCode || "US").trim().toUpperCase();
  return all;
}

async function ensureIdentity() {
  let { clientId, clientLabel } = await chrome.storage.local.get(["clientId", "clientLabel"]);
  if (!clientId) clientId = `ext-${crypto.randomUUID()}`;
  if (!clientLabel) clientLabel = `Chrome ${clientId.slice(-6)}`;
  await chrome.storage.local.set({ clientId, clientLabel });
  return { clientId, clientLabel };
}
/* ===============================
   ORDERS: xin ref + kiểm tra + tải
   ============================== */
function buildNewOrdersPayload(numDays = 1) {
  return {
    type: "fbmOrdersReport",
    reportVersion: "new",
    includeSalesChannel: false,
    numDays: String([1, 2, 7, 15, 30].includes(Number(numDays)) ? numDays : 1),
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
   Poll helper (10s x 18) + chống trùng ref
   =============================== */
const activeRefs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntilReady(
  referenceId,
  { intervalMs = 10000, maxAttempts = 5, onAttempt } = {}
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
      await onAttempt?.(attempt, maxAttempts);
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
async function runImportNewOrders(referenceOverride, numDays) {
  const { ingestUrl, ingestToken, marketplaceCode } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importNewUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    await setOrderImportProgress('REQUESTING_REPORT', 'Requesting Amazon report');
    const newOrdersPayload = buildNewOrdersPayload(numDays);
    console.log(`[IMPORT_ORDERS] Requesting New Orders report with rolling window: ${newOrdersPayload.numDays} days`);
    extensionLogger?.logInfo(`[IMPORT_ORDERS] Requesting New Orders report with rolling window: ${newOrdersPayload.numDays} days`, {
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

  await setOrderImportProgress('WAITING_FOR_REPORT', 'Waiting for Amazon report', { referenceId, attempt: 0, maxAttempts: REPORT_POLL_MAX_ATTEMPTS });

  const st = await pollUntilReady(referenceId, {
    intervalMs: 10000,
    maxAttempts: REPORT_POLL_MAX_ATTEMPTS,
    onAttempt: (attempt, maxAttempts) => setOrderImportProgress('WAITING_FOR_REPORT', 'Waiting for Amazon report', { referenceId, attempt, maxAttempts }),
  });

  let tsv,
    documentId = null,
    rows = 0;
  if (st.direct) {
    tsv = st.tsv;
    rows = parseTSV(tsv).rows.length;
  } else {
    await setOrderImportProgress('DOWNLOADING_REPORT', 'Downloading Amazon report', { referenceId });
    const r = await downloadByDocumentId(st.documentId);
    tsv = r.tsv;
    documentId = r.documentId;
    rows = r.rows;
  }

  const fd = new FormData();
  fd.append("marketplaceCode", marketplaceCode || "US");
  fd.append("originalFilename", `orders-new-${referenceId}.txt`);
  fd.append(
    "file",
    new Blob([tsv], { type: "text/plain" }),
    `orders-new-${referenceId}.txt`
  );

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

  let ingest;
  try {
    await setOrderImportProgress('UPLOADING_TO_BE', 'Uploading report to LNG', { referenceId, rows });
    ingest = await postOrderImport({ url: importNewUrl, token: ingestToken, formData: fd });
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
        hasIngestToken: !!ingestToken,
      },
      "[IMPORT_ORDERS] Backend upload fetch failed before HTTP response"
    );
    throw wrapped;
  }
  await setOrderImportProgress('COMPLETED', 'Order import completed', { referenceId, rows });
  return { ok: true, rows, documentId, referenceId, ingest };
}

/* ===============================
   ADS via content-script
   =============================== */
async function ensureAdsTab() {
  const tabs = await chrome.tabs.query({ url: `${ADS_BASE}/*` });
  let tab = tabs.find((t) => t.url?.includes("/cm/")) || tabs[0];

  if (!tab) {
    debugLog("🌐 [ADS-TAB] Opening Amazon Ads campaigns page...", "info");
    extensionLogger?.logInfo("[ADS-TAB] Opening Amazon Ads campaigns page");
    tab = await chrome.tabs.create({
      url: `${ADS_BASE}/cm/campaigns`,
      active: true,
    });
  } else {
    debugLog(`🌐 [ADS-TAB] Reusing existing ads tab: ${tab.id}`, "info");
    extensionLogger?.logInfo("[ADS-TAB] Reusing existing ads tab", { tabId: tab.id, url: tab.url });
  }

  await waitForAdsTabComplete(tab.id);
  return tab.id;
}

async function ensureAdsReportingTab() {
  const tabs = await chrome.tabs.query({ url: `${ADS_BASE}/*` });
  let tab = tabs.find((candidate) => candidate.url?.includes("/reporting"));

  if (!tab) {
    debugLog("🌐 [ADS-TAB] Opening Amazon Ads Reporting page...", "info");
    extensionLogger?.logInfo("[ADS-TAB] Opening Amazon Ads Reporting page");
    tab = await chrome.tabs.create({ url: `${ADS_BASE}/reporting`, active: true });
  } else {
    debugLog(`🌐 [ADS-TAB] Reusing Amazon Ads Reporting tab: ${tab.id}`, "info");
    extensionLogger?.logInfo("[ADS-TAB] Reusing Amazon Ads Reporting tab", { tabId: tab.id });
  }

  return tab.id;
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
          "x-csrf-token": "adsReportingCsrfToken",
        };

        function normalizeHeaders(headers) {
          const out = {};
          if (!headers) return out;
          try {
            if (typeof headers === "string") {
              headers.split(/\r?\n/).forEach((line) => {
                const separator = line.indexOf(":");
                if (separator > 0) out[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
              });
            } else if (headers instanceof Headers) {
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
          return nativeFetch.apply(this, arguments).then((response) => {
            try {
              const url = typeof input === "string" ? input : input?.url;
              if (url && shouldCapture(url)) publish(response.headers);
            } catch (_) { }
            return response;
          });
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
              this.addEventListener("loadend", () => publish(this.getAllResponseHeaders()));
            }
          } catch (_) { }
          return nativeSend.apply(this, arguments);
        };
      },
    });
    debugLog("✅ [ADS-SNIFFER] Main-world sniffer injected", "success");
    return true;
  } catch (e) {
    debugLog(`⚠️ [ADS-SNIFFER] Main-world injection skipped: ${e?.message || e}`, "info");
    return false;
  }
}

async function ensureAdsBridgeInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ads_bridge.js"],
    });
  } catch (e) {
    // Nếu content script đã tồn tại hoặc tab chưa cho inject, sendMessage phía dưới sẽ xác nhận lại.
    debugLog(`ℹ️ [ADS-BRIDGE] executeScript note: ${e?.message || e}`, "info");
  }
  await injectAdsMainWorldSniffer(tabId);
}

async function adsRetrieveViaContentScript(payload, options = {}) {
  const tabId = await ensureAdsTab();
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
      if (isAdsAuthError(error) && attempt < maxAttempts) {
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

async function adsReportingViaContentScript(operation, payload, options = {}) {
  const tabId = await ensureAdsReportingTab();
  await ensureAdsBridgeInjected(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'ADS_REPORTING_REQUEST',
    operation,
    payload,
    options,
  });
  if (!response?.ok) throw createAdsError(response?.message || `Amazon Ads ${operation} failed`, response?.status || 0);
  return response.data;
}

function reportConfigurations(response) {
  return response?.reportConfigurations || response?.data?.reportConfigurations || [];
}

async function createAndRunAdsReport(reportDate, lock) {
  const { adsAdvertiserId } = await getCfg();
  const queryPayload = { maxResults: 50, sort: [{ by: 'latestScheduledReportLastUpdatedDateTime', direction: 'DESCENDING' }] };
  const templates = reportConfigurations(await adsReportingViaContentScript('QUERY_CONFIGURATIONS', queryPayload, lock));
  const template = findCsvReportTemplate(templates);
  if (!template) throw new Error('Amazon Ads CSV report template is unavailable. Create a Campaign report with Campaign name and Total cost first.');

  const accountId = adsAdvertiserId || template.linkedAccounts?.[0]?.advertiserAccountId;
  if (!accountId) throw new Error('Amazon Ads advertiser account is unavailable. Open the Campaign Manager tab and try again.');
  const created = await adsReportingViaContentScript('CREATE_CONFIGURATION', {
    accessRequestedAccounts: [{ advertiserAccountId: accountId }],
    reportConfigurations: [buildOneOffReportConfig(template, reportDate)],
  }, lock);
  const configurationId = reportConfigurationId(created);
  if (!configurationId) throw new Error('Amazon Ads did not return a report configuration ID.');

  await adsReportingViaContentScript('RUN_CONFIGURATION', {
    accessRequestedAccounts: [{ advertiserAccountId: accountId }],
    scheduledReports: [{ reportConfigurationId: configurationId }],
  }, lock);
  return configurationId;
}

async function waitForAdsReport(configurationId, lock) {
  const queryPayload = { maxResults: 50, sort: [{ by: 'latestScheduledReportLastUpdatedDateTime', direction: 'DESCENDING' }] };
  for (let attempt = 1; attempt <= REPORT_POLL_MAX_ATTEMPTS; attempt += 1) {
    const configurations = reportConfigurations(await adsReportingViaContentScript('QUERY_CONFIGURATIONS', queryPayload, lock));
    const report = configurations.find((item) => item.reportConfigurationId === configurationId);
    const status = report?.latestScheduledReportStatus;
    await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Amazon Ads report polling', { attempt, maxAttempts: REPORT_POLL_MAX_ATTEMPTS, status: status || 'PENDING' });
    if (status === 'COMPLETED') return report;
    if (shouldFailReportStatus(status)) throw new Error(`Amazon Ads report ${String(status).toLowerCase()}.`);
    if (isTerminalReportStatus(status)) throw new Error(`Amazon Ads report ${String(status).toLowerCase()}.`);
    if (attempt < REPORT_POLL_MAX_ATTEMPTS) await delayMs(REPORT_POLL_INTERVAL_MS);
  }
  throw new Error('Amazon Ads report did not complete within three minutes.');
}

async function downloadAdsReportCsv(configurationId, lock) {
  const tabId = await ensureAdsReportingTab();
  await ensureAdsBridgeInjected(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: 'ADS_DOWNLOAD_LATEST_REPORT', configurationId, options: lock });
  if (!response?.downloadUrl) throw new Error(response?.message || 'Amazon Ads Download latest is unavailable. Open the Amazon Reporting tab and try again.');
  try {
    const download = await fetch(response.downloadUrl);
    if (!download.ok) throw new Error(`Amazon Ads CSV download failed (${download.status}).`);
    return await download.blob();
  } finally {
    response.downloadUrl = null;
  }
}

async function runExportAdsSpend({ dateFrom, dateTo }) {
  if ((await getCfg()).ingestUrl !== DEFAULT_ENVIRONMENTS.development.ingestUrl) throw new Error("Ads import is restricted to Development");
  return withAdsApiLock("IMPORT_ADS_SPEND", (lock) => runExportAdsSpendLocked({ dateFrom, dateTo }, lock));
}

async function fetchTransactionsCsvFromAmazon({ dateFrom, dateTo }) {
  return fetchAmazonTransactionsCsv({ dateFrom, dateTo });
}

async function fetchSettlementsTxtFromAmazon() {
  throw new Error("Amazon Settlements export is not implemented yet");
}

async function runImportTransactions({ dateFrom, dateTo } = {}) {
  const { ingestUrl, ingestToken, marketplaceCode } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  if (!dateFrom || !dateTo) throw new Error("dateFrom and dateTo are required");

  const context = { dateFrom, dateTo, taskId: `transactions_${dateFrom}_${dateTo}` };
  await extensionLogger.logTaskProcessing(context, 'Transaction task started');
  try {
    const { transactionsImportUrl } = deriveApiUrls(ingestUrl);
    const csv = await fetchTransactionsCsvFromAmazon({ dateFrom, dateTo });
    const result = await postFileTo(transactionsImportUrl, {
      salesChannelCode: "AMAZON",
      marketplaceCode: marketplaceCode || "US",
      dryRun: "false",
      sourceRef: `transactions-${dateFrom}-${dateTo}.csv`,
      file: { name: `transactions-${dateFrom}-${dateTo}.csv`, text: csv },
    }, ingestToken);
    await extensionLogger.logTaskCompleted(context, result, 'Transaction task completed');
    return result;
  } catch (error) {
    await extensionLogger.logTaskFailed(context, error, 'Transaction task failed');
    throw error;
  }
}

async function runImportSettlements({ dateFrom, dateTo } = {}) {
  const { ingestUrl, ingestToken, marketplaceCode } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  if (!dateFrom || !dateTo) throw new Error("dateFrom and dateTo are required");

  const { settlementsImportUrl } = deriveApiUrls(ingestUrl);
  const text = await fetchSettlementsTxtFromAmazon({ dateFrom, dateTo });
  return postFileTo(settlementsImportUrl, {
    salesChannelCode: "AMAZON",
    marketplaceCode: marketplaceCode || "US",
    dryRun: "false",
    sourceRef: `settlements-${dateFrom}-${dateTo}.txt`,
    file: { name: `settlements-${dateFrom}-${dateTo}.txt`, text },
  }, ingestToken);
}

async function runExportAdsSpendLocked({ dateFrom, dateTo }, lock = {}) {
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
      batchId: `ads_${dateFrom}_${dateTo}`,
      ordersCount: 0,
      filename: `ads-spend-${dateFrom}-${dateTo}.csv`
    }, `[IMPORT_ADS_SPEND] Starting ads spend export for ${dateFrom} to ${dateTo}`);
  }

  const { ingestUrl, ingestToken, marketplaceCode } = await getCfg();
  if (!ingestUrl) {
    const error = new Error("Missing ingestUrl (Options)");
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${dateFrom}_${dateTo}`
      }, error, '[IMPORT_ADS_SPEND] Ads export failed: Missing ingestUrl');
    }
    throw error;
  }

  const { adsSpendUrl } = deriveApiUrls(ingestUrl);

  // Đảm bảo Ads headers còn hạn trước khi gọi Ads API
  await ensureFreshAdsReportingHeaders();

  if (!dateFrom || !dateTo) {
    const error = new Error("dateFrom and dateTo (YYYY-MM-DD) are required");
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${dateFrom}_${dateTo}`
      }, error, '[IMPORT_ADS_SPEND] Ads export failed: Missing date parameter');
    }
    throw error;
  }
  try {
    await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Creating one-time Amazon Reporting CSV', { dateFrom, dateTo });
    const configurationId = await createAndRunAdsReport(dateFrom, lock);
    await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Amazon Reporting CSV requested', { dateFrom, dateTo });
    await waitForAdsReport(configurationId, lock);
    const csv = await downloadAdsReportCsv(configurationId, lock);
    const filename = `ads-report-${dateFrom}.csv`;

    await extensionLogger.logInfo('[IMPORT_ADS_SPEND] Uploading original Amazon Reporting CSV', {
      fileSize: csv.size,
      filename,
    });

    const ingestRes = await postFileTo(adsSpendUrl, {
      salesChannelCode: "AMAZON",
      marketplaceCode: marketplaceCode || "US",
      dryRun: "false",
      sourceRef: filename,
      filename,
      file: csv,
    }, ingestToken);

    const endTime = Date.now();

    // Log task completed
    if (extensionLogger) {
      await extensionLogger.logTaskCompleted({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${dateFrom}_${dateTo}`,
        ordersCount: 0,
        filename
      }, {
        duration: endTime - startTime,
        memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
        cpuUsage: 0
      }, `Xuất chi phí quảng cáo hoàn thành thành công cho ${dateFrom} đến ${dateTo}`);
    }

    return { ok: true, rows: ingestRes?.data?.rowCount || 0, ingest: ingestRes };

  } catch (error) {
    // Log task failed
    if (extensionLogger) {
      await extensionLogger.logTaskFailed({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${dateFrom}_${dateTo}`,
        ordersCount: 0,
        filename: `ads-spend-${dateFrom}-${dateTo}.csv`
      }, error, `Xuất chi phí quảng cáo thất bại cho ${dateFrom} đến ${dateTo}`);
    }
    throw error;
  }
}

async function getBaseShopAndIdentity() { const config = await getCfg(); const { clientId, clientLabel } = await ensureIdentity(); return { base: deriveApiUrls(config.ingestUrl).base, clientId, clientLabel }; }
async function gmailAdsDownloadKey(url) {
  const bytes = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}
async function uploadGmailAdsDownload(url) {
  const report = classifyAmazonAdsReportLink(url);
  if (!report) return { ok: false, ignored: true };
  const config = await getCfg();
  const key = await gmailAdsDownloadKey(createGmailAdsDownloadFingerprint(config.ingestUrl, url));
  const task = {
    taskId: `gmail-ads-${key.slice(0, 12)}`,
    taskType: 'IMPORT_ADS_SPEND',
    filename: report.filename,
  };
  const now = Date.now();
  const stored = await chrome.storage.local.get(GMAIL_ADS_RECENT_DOWNLOADS_KEY);
  const recent = (stored[GMAIL_ADS_RECENT_DOWNLOADS_KEY] || {}).entries || {};
  for (const [item, timestamp] of Object.entries(recent)) if (now - timestamp > GMAIL_ADS_RECENT_DOWNLOADS_TTL_MS) delete recent[item];
  await extensionLogger.logTaskProcessing(task, 'Downloading Amazon Ads report from Gmail');
  try {
    if (recent[key]) {
      await extensionLogger.logTaskCompleted(task, null, 'Amazon Ads report upload completed (already imported)');
      return { ok: true, skipped: true, reason: 'ALREADY_IMPORTED' };
    }

    const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!response.ok) throw new Error(`Amazon Ads email download failed (${response.status}).`);
    const file = await response.blob();
    if (!file.size || file.size > GMAIL_ADS_MAX_FILE_SIZE) throw new Error('Amazon Ads email report has an invalid file size.');
    const { adsSpendUrl } = deriveApiUrls(config.ingestUrl);
    const result = await postFileTo(adsSpendUrl, {
      salesChannelCode: 'AMAZON', marketplaceCode: config.marketplaceCode || 'US', dryRun: 'false',
      sourceRef: report.filename, filename: report.filename, file,
    }, config.ingestToken);
    recent[key] = now;
    await chrome.storage.local.set({ [GMAIL_ADS_RECENT_DOWNLOADS_KEY]: { entries: recent } });
    await extensionLogger.logTaskCompleted(task, result, 'Amazon Ads report upload completed');
    return { ok: true, rows: result?.data?.rowCount || 0, ingest: result };
  } catch (error) {
    await extensionLogger.logTaskFailed(task, error, `Amazon Ads report upload failed: ${error?.message || String(error)}`);
    throw error;
  }
}
async function runFullFlowAndEmitLogs(numDays) { try { const importResult = await runImportNewOrders(undefined, numDays); return { ok: true, phases: [{ type: "import", status: "success", rows: importResult?.rows || 0 }], result: importResult }; } catch (error) { await setOrderImportProgress('FAILED', 'Order import failed', { error: error?.message || String(error) }); throw error; } }
async function pollExtensionCommands(config = null) { config ||= await getCfg(); const identity = await getBaseShopAndIdentity(); return pollExtensionCommand({ base: identity.base, token: config.ingestToken, client: { clientId: identity.clientId, label: identity.clientLabel, version: chrome.runtime.getManifest().version, apiBaseUrl: identity.base }, runImport: (numDays) => runFullFlowAndEmitLogs(numDays), runAds: ({ dateFrom, dateTo }) => runExportAdsSpend({ dateFrom, dateTo }) }); }
async function queueManualOrderImport() { const config = await getCfg(); const identity = await getBaseShopAndIdentity(); const client = { clientId: identity.clientId, label: identity.clientLabel, version: chrome.runtime.getManifest().version, apiBaseUrl: identity.base }; const command = await queueOrderImportCommand({ base: identity.base, token: config.ingestToken, client }); await setOrderImportProgress('QUEUED', 'Import queued'); await pollExtensionCommandsWithBackoff({ force: true }); return { ok: true, commandId: command.id }; }
async function queueManualAdsSpend(date) { const config = await getCfg(); const identity = await getBaseShopAndIdentity(); const client = { clientId: identity.clientId, label: identity.clientLabel, version: chrome.runtime.getManifest().version, apiBaseUrl: identity.base }; const command = await queueAdsSpendCommand({ base: identity.base, token: config.ingestToken, client, date }); await pollExtensionCommandsWithBackoff({ force: true }); return { ok: true, commandId: command.id }; }
async function pollExtensionCommandsWithBackoff({ force = false } = {}) {
  const now = Date.now();
  const state = await chrome.storage.local.get(EXTENSION_COMMAND_POLL_BACKOFF_KEY);
  const backoff = state[EXTENSION_COMMAND_POLL_BACKOFF_KEY] || {};
  if (!force && backoff.nextAttemptAt > now) return null;
  const config = await getCfg();
  if (!config.ingestUrl || !config.ingestToken) {
    await chrome.storage.local.remove(EXTENSION_COMMAND_POLL_BACKOFF_KEY);
    await chrome.storage.local.set({ [EXTENSION_CONNECTION_STATUS_KEY]: { state: "NOT_CONFIGURED", lastHeartbeatAt: null, nextPollAt: null, lastTask: null } });
    return null;
  }
  try {
    const result = await pollExtensionCommands(config);
    await chrome.storage.local.remove(EXTENSION_COMMAND_POLL_BACKOFF_KEY);
    await chrome.storage.local.set({ [EXTENSION_CONNECTION_STATUS_KEY]: { state: "CONNECTED", lastHeartbeatAt: now, nextPollAt: now + 60_000, lastTask: result || null } });
    return result;
  } catch (error) {
    const failures = Math.min(Number(backoff.failures || 0) + 1, EXTENSION_COMMAND_POLL_BACKOFF_MINUTES.length);
    const delayMinutes = EXTENSION_COMMAND_POLL_BACKOFF_MINUTES[failures - 1];
    await chrome.storage.local.set({ [EXTENSION_COMMAND_POLL_BACKOFF_KEY]: { failures, nextAttemptAt: now + delayMinutes * 60_000 } });
    await chrome.storage.local.set({ [EXTENSION_CONNECTION_STATUS_KEY]: { state: "DISCONNECTED", lastHeartbeatAt: backoff.lastHeartbeatAt || null, nextPollAt: now + delayMinutes * 60_000, lastTask: null } });
    throw error;
  }
}
async function startExtensionCommandPolling() { await chrome.alarms.create(EXTENSION_COMMAND_POLL_ALARM, { periodInMinutes: 1 }); await pollExtensionCommandsWithBackoff().catch(() => undefined); }
chrome.runtime.onInstalled.addListener(() => startExtensionCommandPolling());
chrome.runtime.onStartup.addListener(() => startExtensionCommandPolling());
chrome.storage.onChanged.addListener((changes) => { if (changes.ingestUrl || changes.ingestToken) startExtensionCommandPolling(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm?.name === EXTENSION_COMMAND_POLL_ALARM) pollExtensionCommandsWithBackoff().catch(() => undefined); });
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => { (async () => { if (msg?.type === "PING") return sendResponse({ ok: true }); if (msg?.type === "HEARTBEAT_NOW") { await pollExtensionCommandsWithBackoff({ force: true }); return sendResponse({ ok: true, message: "Heartbeat completed." }); } if (msg?.type === "AUTO_RUN_NOW") return sendResponse(await queueManualOrderImport()); if (msg?.type === "RUN_ADS_SPEND") return sendResponse(await queueManualAdsSpend(msg.payload?.date)); if (msg?.type === "RUN_TRANSACTIONS_IMPORT") return sendResponse(await runImportTransactions(msg.payload || {})); if (msg?.type === "RUN_SETTLEMENTS_IMPORT") return sendResponse(await runImportSettlements(msg.payload || {})); if (msg?.type === "GMAIL_AMAZON_ADS_DOWNLOAD") return sendResponse(await uploadGmailAdsDownload(msg.url)); return sendResponse({ ok: false, error: "Unsupported action" }); })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) })); return true; });
