/* Amazon order, ads, transaction, settlement imports and LNG command polling. */
import { deriveApiUrls } from "./config.js";
import { pollExtensionCommand } from "./extensionCommandClient.js";
import { postFileTo, postOrderImport } from "./backendApi.js";
import { createExtensionLogger } from "./extensionLogger.js";
const ADS_LOCK_STALE_MS = 5 * 60 * 1000;
const EXTENSION_COMMAND_POLL_ALARM = "EXTENSION_COMMAND_POLL";
const EXTENSION_COMMAND_POLL_BACKOFF_KEY = "extensionCommandPollBackoff";
const EXTENSION_CONNECTION_STATUS_KEY = "extensionConnectionStatus";
const EXTENSION_COMMAND_POLL_BACKOFF_MINUTES = [1, 2, 5, 10];
const adsApiLock = { running: false, taskName: "", runId: "", startedAt: 0 };
const extensionLogger = createExtensionLogger({ storage: chrome.storage.local });
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
  "adsHeaderLastSeen",
];
const ADS_HEADER_REFRESH_TIMEOUT_MS = 25 * 1000;
const ADS_TAB_LOAD_TIMEOUT_MS = 35 * 1000;
const ADS_PAGE_SETTLE_MS = 3500;

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
async function forceRefreshAdsHeaders() {
  const tabId = await ensureAdsTab();
  await ensureAdsBridgeInjected(tabId);
  await chrome.tabs.reload(tabId);
  await waitForAdsTabComplete(tabId);
  await delayMs(ADS_PAGE_SETTLE_MS);
  const state = await chrome.storage.local.get([...ADS_HEADER_STORAGE_KEYS, "adsCandidateHeaders"]);
  const headers = { ...(state.adsCandidateHeaders || {}), ...state };
  if (!isAdsHeaderComplete(headers)) throw createAdsError("Amazon Ads headers are unavailable. Sign in to advertising.amazon.com and open the campaign page.", 401);
  await chrome.storage.local.set(Object.fromEntries(ADS_HEADER_STORAGE_KEYS.map((key) => [key, headers[key]])));
}
async function ensureFreshAdsHeaders() {
  const state = await readAdsHeaderState();
  if (isAdsHeaderComplete(state)) return;
  await forceRefreshAdsHeaders();
}

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
    "adsHeaderLastSeen",
    // Auto
    "autoEnabled",
    "autoUpload_enabled", "autoUpload_interval",
    ...keys,
  ]);
  const environment = all.activeEnvironment || "production";
  const environmentConfig = all.ingestEnvironments?.[environment];
  if (environmentConfig) {
    all.ingestUrl = environmentConfig.ingestUrl || all.ingestUrl;
    all.ingestToken = environmentConfig.ingestToken || all.ingestToken;
    all.marketplaceCode = environmentConfig.marketplaceCode || all.marketplaceCode;
  }
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
    type: "newOrdersReport",
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
async function runImportNewOrders(referenceOverride, numDays) {
  const { ingestUrl, ingestToken } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importNewUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
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
    }

    const processedData = all.map((r) => ({
      campaignName: r.campaignName ?? "",
      date: r.date ?? startDate,
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

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function campaignRowsToCsv(rows) {
  const header = "Date,Campaign Name,Spend";
  const lines = rows.map((r) =>
    [
      r.date,
      r.campaignName,
      r.spend,
    ].map(csvCell).join(",")
  );
  return [header, ...lines].join("\n");
}

async function runExportAdsSpend({ dateFrom, dateTo }) {
  return withAdsApiLock("IMPORT_ADS_SPEND", (lock) => runExportAdsSpendLocked({ dateFrom, dateTo }, lock));
}

async function fetchTransactionsCsvFromAmazon() {
  throw new Error("Amazon Transactions export is not implemented yet");
}

async function fetchSettlementsTxtFromAmazon() {
  throw new Error("Amazon Settlements export is not implemented yet");
}

async function runImportTransactions({ dateFrom, dateTo } = {}) {
  const { ingestUrl, ingestToken, marketplaceCode } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  if (!dateFrom || !dateTo) throw new Error("dateFrom and dateTo are required");

  const { transactionsImportUrl } = deriveApiUrls(ingestUrl);
  const csv = await fetchTransactionsCsvFromAmazon({ dateFrom, dateTo });
  return postFileTo(transactionsImportUrl, {
    salesChannelCode: "AMAZON",
    marketplaceCode: marketplaceCode || "US",
    dryRun: "false",
    sourceRef: `transactions-${dateFrom}-${dateTo}.csv`,
    file: { name: `transactions-${dateFrom}-${dateTo}.csv`, text: csv },
  }, ingestToken);
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
  await ensureFreshAdsHeaders({ ...lock, reason: "runExportAdsSpend" });

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
    // Log fetching campaign data
    if (extensionLogger) {
      await extensionLogger.logInfo('Lấy dữ liệu chi phí campaign từ Amazon', {
        dateFrom,
        dateTo,
        endpoint: 'Amazon Ads API',
        timestamp: new Date().toISOString()
      });
    }

    const rows = await fetchAllCampaignSpend(dateFrom, dateTo, 300, false, lock);

    // Log data processing
    if (extensionLogger) {
      await extensionLogger.logInfo('Xử lý dữ liệu chi phí campaign', {
        rowCount: rows.length,
        dateFrom,
        dateTo,
        timestamp: new Date().toISOString()
      });
    }

    const csv = campaignRowsToCsv(rows);

    // Log uploading to backend
    if (extensionLogger) {
      await extensionLogger.logInfo('Upload dữ liệu chi phí quảng cáo lên backend', {
        url: adsSpendUrl,
        fileSize: csv.length,
        rowCount: rows.length,
        filename: `ads-spend-${dateFrom}-${dateTo}.csv`,
        timestamp: new Date().toISOString()
      });
    }

    const ingestRes = await postFileTo(adsSpendUrl, {
      salesChannelCode: "AMAZON",
      marketplaceCode: marketplaceCode || "US",
      dryRun: "false",
      sourceRef: `ads-spend-${dateFrom}-${dateTo}.csv`,
      file: { name: `ads-spend-${dateFrom}-${dateTo}.csv`, text: csv },
    }, ingestToken);

    const endTime = Date.now();

    // Log task completed
    if (extensionLogger) {
      await extensionLogger.logTaskCompleted({
        taskId: `ads_export_${startTime}`,
        taskType: 'IMPORT_ADS_SPEND',
        batchId: `ads_${dateFrom}_${dateTo}`,
        ordersCount: rows.length,
        filename: `ads-spend-${dateFrom}-${dateTo}.csv`
      }, {
        duration: endTime - startTime,
        memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
        cpuUsage: 0
      }, `Xuất chi phí quảng cáo hoàn thành thành công cho ${dateFrom} đến ${dateTo}`);
    }

    return { ok: true, rows: rows.length, ingest: ingestRes };

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
async function runFullFlowAndEmitLogs(numDays) { const importResult = await runImportNewOrders(undefined, numDays); return { ok: true, phases: [{ type: "import", status: "success", rows: importResult?.rows || 0 }], result: importResult }; }
async function pollExtensionCommands() { const config = await getCfg(); const identity = await getBaseShopAndIdentity(); return pollExtensionCommand({ base: identity.base, token: config.ingestToken, client: { clientId: identity.clientId, label: identity.clientLabel, version: chrome.runtime.getManifest().version, apiBaseUrl: identity.base }, runImport: (numDays) => runFullFlowAndEmitLogs(numDays), runAds: ({ dateFrom, dateTo }) => runExportAdsSpend({ dateFrom, dateTo }) }); }
async function pollExtensionCommandsWithBackoff({ force = false } = {}) {
  const now = Date.now();
  const state = await chrome.storage.local.get(EXTENSION_COMMAND_POLL_BACKOFF_KEY);
  const backoff = state[EXTENSION_COMMAND_POLL_BACKOFF_KEY] || {};
  if (!force && backoff.nextAttemptAt > now) return null;
  try {
    const result = await pollExtensionCommands();
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
const ADS_HEADER_KEYS = { "amazon-ads-account-id": "adsAccountId", "amazon-advertising-api-advertiserid": "adsAdvertiserId", "amazon-advertising-api-clientid": "adsClientId", "amazon-advertising-api-marketplaceid": "adsMarketplaceId", "amazon-advertising-api-csrf-data": "adsCsrfData", "amazon-advertising-api-csrf-token": "adsCsrfToken" };
chrome.webRequest.onBeforeSendHeaders.addListener((details) => { const found = Object.fromEntries((details.requestHeaders || []).map((h) => [ADS_HEADER_KEYS[String(h.name || "").toLowerCase()], h.value]).filter(([k, v]) => k && v)); if (Object.keys(found).length) chrome.storage.local.set({ ...found, adsHeaderLastSeen: Date.now() }); }, { urls: ["https://advertising.amazon.com/*"] }, ["requestHeaders", "extraHeaders"]);
chrome.runtime.onInstalled.addListener(() => startExtensionCommandPolling());
chrome.runtime.onStartup.addListener(() => startExtensionCommandPolling());
chrome.storage.onChanged.addListener((changes) => { if (changes.ingestUrl || changes.ingestToken) startExtensionCommandPolling(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm?.name === EXTENSION_COMMAND_POLL_ALARM) pollExtensionCommandsWithBackoff().catch(() => undefined); });
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => { (async () => { if (msg?.type === "PING") return sendResponse({ ok: true }); if (msg?.type === "HEARTBEAT_NOW") { await pollExtensionCommandsWithBackoff({ force: true }); return sendResponse({ ok: true, message: "Heartbeat completed." }); } if (msg?.type === "AUTO_RUN_NOW") return sendResponse(await runFullFlowAndEmitLogs("manual")); if (msg?.type === "RUN_ADS_SPEND") return sendResponse(await runExportAdsSpend({ dateFrom: msg.payload?.dateFrom || msg.payload?.date, dateTo: msg.payload?.dateTo || msg.payload?.date })); if (msg?.type === "RUN_TRANSACTIONS_IMPORT") return sendResponse(await runImportTransactions(msg.payload || {})); if (msg?.type === "RUN_SETTLEMENTS_IMPORT") return sendResponse(await runImportSettlements(msg.payload || {})); return sendResponse({ ok: false, error: "Unsupported action" }); })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) })); return true; });
