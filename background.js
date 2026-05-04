/* ===============================
   background.js (MV3, ESM) — APO LNG (Realtime only)
   - Không ghi DB: không /api/ext/connect, không /api/logs/*
   - Chỉ Socket.IO realtime: ext:heartbeat, ext:log, client:ack
   - Import NEW / Report ALL / Ads vẫn hoạt động như cũ
   - Auto: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 (giờ LOCAL)
   =============================== */

import { io } from "./lib/socket.io.esm.min.js";

// Global logger instance
let extensionLogger = null;

// Test connection polling
let testConnectionInterval = null;

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
      level: status === 'connected' ? 'info' : 'warn',
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

const log = (...args) => {
  const message = `[${new Date().toLocaleTimeString()}] ` + args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.log("[APO]", ...args);  // Giữ console.log cho debug
  // Gửi đến popup để hiển thị trên màn hình
  chrome.runtime.sendMessage({ type: "LOG", payload: message }).catch(() => { });  // Ignore lỗi nếu popup không mở
};

const SC_BASE = "https://sellercentral.amazon.com";
const ADS_BASE = "https://advertising.amazon.com";
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

async function clearAdsHeaders(reason = "unknown") {
  await chrome.storage.local.remove(ADS_HEADER_STORAGE_KEYS);
  debugLog(`🧹 [ADS-AUTH] Cleared cached Ads headers: ${reason}`, "info");
  extensionLogger?.logInfo("[ADS-AUTH] Cleared cached Ads headers", { reason });
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
      }
      resolve(!!ok);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    const watched = new Set(ADS_HEADER_STORAGE_KEYS);
    const listener = async (changes, areaName) => {
      if (areaName !== "local") return;
      if (!Object.keys(changes || {}).some((k) => watched.has(k))) return;
      const latest = await readAdsHeaderState();
      if (isAdsHeaderComplete(latest) && (!since || Number(latest.adsHeaderLastSeen || 0) >= since - 1000)) {
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

  if (tracking.startsWith("4PX")) {
    return { carrierCode: "4PX", shipMethod: "4PX-Global Express" };
  }

  if (tracking.startsWith("UK") || tracking.startsWith("UL")) {
    return { carrierCode: "Yanwen", shipMethod: "Yanwen Air Economy Mail General" };
  }
  if (tracking.startsWith("YT")) {
    return { carrierCode: "Yun Express", shipMethod: "YunExpress Global Direct line (standard )-Tracked" };
  }
  return { carrierCode: "USPS", shipMethod: "USPS First Class" };
}

async function uploadtracking() {
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
      const tracking = o.tracking || "";
      const shipDate = new Date().toISOString();
      const { carrierCode, shipMethod } = resolveCarrierInfo(tracking);

      return `${o.orderId}\t${shipDate}\t${carrierCode}\t${tracking}\t${shipMethod}`;
    });

    const tsvContent =
      "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n" +
      tsvLines.join("\n");

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

    });

    await uploadToAmazon(fileObj, {
      batchId: `auto_${Date.now()}`,
      ordersCount: pendingOrders.length,
      carrierCode: "Mixed",
      shipMethod: "Mixed",
      shipDate: new Date().toISOString(),
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
   =============================== */
function buildNewOrdersPayload() {
  return {
    type: "newOrdersReport",
    reportVersion: "new",
    includeSalesChannel: false,
    numDays: "1",
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
  const { ingestUrl, shopId, ingestToken, refNewOrders } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { importNewUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    try {
      referenceId = await requestReferenceIdNew(buildNewOrdersPayload());
    } catch (e) {
      referenceId = refNewOrders;
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

  const resp = await fetch(importNewUrl, {
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
          } catch (_) {}
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
          } catch (_) {}
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
          } catch (_) {}
          return nativeSetRequestHeader.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function patchedSend() {
          try {
            if (this.__apoAdsUrl && shouldCapture(this.__apoAdsUrl)) {
              publish(this.__apoAdsHeaders || {});
            }
          } catch (_) {}
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

async function adsRetrieveViaContentScript(payload) {
  const tabId = await ensureAdsTab();
  await ensureAdsBridgeInjected(tabId);

  const sendOnce = () =>
    chrome.tabs.sendMessage(tabId, {
      type: "ADS_FETCH_REPORT",
      url: ADS_RETRIEVE_URL,
      payload,
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        debugLog(`🔁 [ADS-AUTH] Retrying retrieveReport after auth refresh (${attempt}/${maxAttempts})`, "info");
        await ensureFreshAdsHeaders({ force: true, reason: `retry-${attempt}` });
      }

      extensionLogger?.logInfo("[IMPORT_ADS_SPEND] Making Amazon Ads API call via content script", {
        attempt,
        maxAttempts,
        payloadKeys: Object.keys(payload || {}),
        startDate: payload?.startDate,
        endDate: payload?.endDate,
        offset: payload?.offset,
        size: payload?.size,
        timestamp: new Date().toISOString(),
      });

      const r = await adsRetrieveViaContentScript(payload);
      if (!r) throw createAdsError("retrieveReport no response", 0, "");

      const sample = typeof r.text === "string" ? r.text : JSON.stringify(r.text || "");

      if (!r.ok) {
        const error = createAdsError(`retrieveReport ${r.status} — ${sample.slice(0, 200)}`, r.status, sample);
        extensionLogger?.logError(error, {
          status: r.status,
          attempt,
          responseText: sample.slice(0, 500),
          payload,
          endpoint: "Amazon Ads API",
        }, "[IMPORT_ADS_SPEND] Amazon Ads API request failed");

        if (isAdsAuthError(error) && attempt < maxAttempts) {
          await clearAdsHeaders(`retrieveReport-${r.status}`);
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
          responseText: sample.slice(0, 500),
          parseError: parseError.message,
          payload,
          endpoint: "Amazon Ads API",
        }, "[IMPORT_ADS_SPEND] Amazon Ads API returned non-JSON response");

        if (isAdsAuthError(error) && attempt < maxAttempts) {
          await clearAdsHeaders("retrieveReport-non-json-auth-page");
          lastError = error;
          continue;
        }
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (isAdsAuthError(error) && attempt < maxAttempts) {
        await clearAdsHeaders(`catch-${error.status || error.code || "auth"}`);
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
  isCheckCampain = false
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
      })
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
        })
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

async function runExportAdsSpend(date) {
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
  await ensureFreshAdsHeaders({ reason: "runExportAdsSpend" });

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

    const rows = await fetchAllCampaignSpend(date, date, 300);

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

    return { ok: true, rows: rows.length, ingest: ingestRes };

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

async function uploadToAmazon(fileObj, uploadParams) {
  const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();
  const startTime = Date.now();

  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  try {
    console.log(`[UPLOAD_TRACKING] Starting upload for file: ${fileObj.name}`);
    debugLog(`🚀 [UPLOAD_TRACKING] Starting upload for: ${fileObj.name}`, 'info');

    // Log upload start with extension logger
    if (extensionLogger) {
      await extensionLogger.logUploadStarted({
        filename: fileObj.name,
        fileSize: fileObj.size,
        progress: 0,
        carrier: uploadParams?.carrierCode,
        shipMethod: uploadParams?.shipMethod,
        ordersUploaded: 0
      }, {
        taskId: `upload_${Date.now()}`,
        taskType: 'UPLOAD_TRACKING',
        batchId: uploadParams?.batchId || `upload_${Date.now()}`
      }, 'Starting upload to Amazon Seller Central');
    }

    // Log upload start
    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "info",
      message: `🚀 Starting upload to Amazon: ${fileObj.name}`
    });

    // First, get CSRF token by visiting the feeds page
    let csrfToken = uploadParams?.csrfToken;

    // Log initial CSRF token status
    debugLog(`🔍 [UPLOAD_TRACKING] Initial CSRF token: ${csrfToken ? 'Provided' : 'Not provided'}`, 'info');
    if (csrfToken) {
      debugLog(`🔑 [UPLOAD_TRACKING] Provided CSRF token preview: ${csrfToken.slice(0, 20)}...`, 'info');
    }

    if (!csrfToken) {
      debugLog(`🔍 [UPLOAD_TRACKING] Getting CSRF token from feeds page...`, 'info');

      // Log CSRF token retrieval
      if (extensionLogger) {
        await extensionLogger.logInfo('Retrieving CSRF token from Amazon feeds page', {
          endpoint: '/order-reports-and-feeds/feeds',
          timestamp: new Date().toISOString()
        });
      }

      try {
        // Visit the feeds page to get CSRF token
        const feedsPageUrl = "https://sellercentral.amazon.com/order-reports-and-feeds/feeds";
        debugLog(`📄 [UPLOAD_TRACKING] Fetching feeds page: ${feedsPageUrl}`, 'info');

        const feedsResponse = await requestOnce(feedsPageUrl, {
          method: 'GET'
        });

        debugLog(`📄 [UPLOAD_TRACKING] Feeds page response: ${feedsResponse.status} ${feedsResponse.statusText}`,
          feedsResponse.ok ? 'success' : 'error');

        if (feedsResponse.ok) {
          const feedsHtml = await feedsResponse.text();
          debugLog(`📄 [UPLOAD_TRACKING] Feeds page loaded, size: ${feedsHtml.length} chars`, 'info');

          // Extract CSRF token from the page HTML
          // Look for patterns like: csrfToken":"TOKEN_VALUE" or name="csrfToken" value="TOKEN_VALUE"
          const csrfMatches = [
            /csrfToken['"]\s*:\s*['"]([^'"]+)['"]/i,
            /name=['"]csrfToken['"][^>]*value=['"]([^'"]+)['"]/i,
            /anti-csrftoken-a2z['"]\s*:\s*['"]([^'"]+)['"]/i,
            /"csrfToken"\s*:\s*"([^"]+)"/i,
            /window\.csrfToken\s*=\s*['"]([^'"]+)['"]/i,
            /data-csrf-token=['"]([^'"]+)['"]/i
          ];

          debugLog(`� [UPLOAD_TRACKINxG] Trying ${csrfMatches.length} CSRF token patterns...`, 'info');

          for (const [index, regex] of csrfMatches.entries()) {
            const match = feedsHtml.match(regex);
            if (match && match[1]) {
              csrfToken = match[1];
              debugLog(`🔑 [UPLOAD_TRACKING] CSRF Token extracted with pattern ${index + 1}: ${csrfToken.slice(0, 20)}...`, 'success');

              // Log successful CSRF extraction
              if (extensionLogger) {
                await extensionLogger.logInfo('CSRF token extracted successfully', {
                  source: 'feeds_page',
                  pattern: index + 1,
                  tokenLength: csrfToken.length,
                  tokenPreview: csrfToken.slice(0, 20) + '...',
                  timestamp: new Date().toISOString()
                });
              }
              break;
            } else {
              debugLog(`❌ [UPLOAD_TRACKING] Pattern ${index + 1} failed`, 'info');
            }
          }
        } else {
          debugLog(`❌ [UPLOAD_TRACKING] Failed to fetch feeds page: ${feedsResponse.status}`, 'error');
        }
      } catch (error) {
        debugLog(`⚠️ [UPLOAD_TRACKING] Failed to get CSRF from page: ${error.message}`, 'error');

        // Log CSRF extraction error
        if (extensionLogger) {
          await extensionLogger.logError(error, {
            source: 'feeds_page',
            endpoint: '/order-reports-and-feeds/feeds'
          }, 'Failed to extract CSRF token from feeds page');
        }
      }
    }

    // Fallback: try to get from cookie
    if (!csrfToken) {
      debugLog(`🍪 [UPLOAD_TRACKING] Trying to get CSRF token from cookie...`, 'info');
      csrfToken = await getCookie("https://sellercentral.amazon.com/", "anti-csrftoken-a2z");
      if (csrfToken) {
        debugLog(`🔑 [UPLOAD_TRACKING] CSRF Token from cookie: ${csrfToken.slice(0, 20)}...`, 'info');

        // Log cookie CSRF retrieval
        if (extensionLogger) {
          await extensionLogger.logInfo('CSRF token retrieved from cookie', {
            source: 'cookie',
            tokenLength: csrfToken.length,
            tokenPreview: csrfToken.slice(0, 20) + '...',
            timestamp: new Date().toISOString()
          });
        }
      } else {
        debugLog(`❌ [UPLOAD_TRACKING] No CSRF token found in cookie`, 'error');
      }
    }

    debugLog(`🔑 [UPLOAD_TRACKING] Final CSRF Token: ${csrfToken ? 'Found' : 'Missing'}`, csrfToken ? 'success' : 'error');

    // Debug: Check critical cookies before upload
    debugLog(`🍪 [UPLOAD_TRACKING] Checking authentication cookies...`, 'info');
    log(`🍪 Checking authentication cookies...`);
    const criticalCookies = {
      'session-id': await getCookie("https://sellercentral.amazon.com/", "session-id"),
      'session-token': await getCookie("https://sellercentral.amazon.com/", "session-token"),
      'ubid-main': await getCookie("https://sellercentral.amazon.com/", "ubid-main"),
      'anti-csrftoken-a2z': await getCookie("https://sellercentral.amazon.com/", "anti-csrftoken-a2z")
    };

    for (const [name, value] of Object.entries(criticalCookies)) {
      debugLog(`  - ${name}: ${value ? 'Found' : 'Missing'}`, value ? 'success' : 'error');
      log(`  - ${name}: ${value ? 'Found' : 'Missing'}`);
    }

    if (!criticalCookies['session-id'] || !criticalCookies['session-token']) {
      debugLog(`⚠️ [UPLOAD_TRACKING] Critical session cookies missing - upload likely to fail`, 'error');
      log(`⚠️ Critical session cookies missing - upload likely to fail`);
    }

    // Amazon Seller Central upload endpoint
    const uploadEndpoints = [
      "https://sellercentral.amazon.com/order-reports-and-feeds/api/uploadFeed",
      "https://sellercentral.amazon.com/feeds/api/uploadFeed",
      "https://sellercentral.amazon.com/api/feeds/upload",
      "https://sellercentral.amazon.com/order-reports-and-feeds/feeds/api/upload"
    ];

    let uploadUrl = uploadEndpoints[0]; // Default
    debugLog(`📡 [UPLOAD_TRACKING] Upload endpoint: ${uploadUrl}`, 'info');
    log(`📡 Trying upload endpoint: ${uploadUrl}`);

    // Prepare FormData for Amazon upload (exactly like DevTools)
    const formData = new FormData();
    formData.append('feedFile', fileObj); // Binary file
    formData.append('feedName', 'confirmShipment');
    formData.append('feedVersion', 'new');

    debugLog(`📦 [UPLOAD_TRACKING] FormData prepared:`, 'info');
    debugLog(`  - feedFile: ${fileObj.name} (${fileObj.size} bytes)`, 'info');
    debugLog(`  - feedName: confirmShipment`, 'info');
    debugLog(`  - feedVersion: new`, 'info');

    if (csrfToken) {
      formData.append('csrfToken', csrfToken);
      debugLog(`🔑 [UPLOAD_TRACKING] CSRF Token added to FormData: ${csrfToken.slice(0, 30)}...`, 'info');
    } else {
      debugLog(`⚠️ [UPLOAD_TRACKING] No CSRF Token - upload will likely fail`, 'error');

      // Log missing CSRF token
      if (extensionLogger) {
        await extensionLogger.logError(new Error('No CSRF token available'), {
          uploadUrl: uploadUrl,
          filename: fileObj.name
        }, 'Upload proceeding without CSRF token - likely to fail');
      }
    }

    console.log(`[UPLOAD_TRACKING] Uploading to: ${uploadUrl}`);
    debugLog(`🚀 [UPLOAD_TRACKING] Starting upload request...`, 'info');

    // Log upload attempt with extension logger
    if (extensionLogger) {
      await extensionLogger.logInfo('Sending file to Amazon Seller Central', {
        filename: fileObj.name,
        progress: 50,
        ordersUploaded: 0
      });
    }

    // Log upload attempt
    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "info",
      message: `📡 Uploading to Amazon Seller Central...`
    });

    // Upload using requestOnce (same pattern as requestReferenceIdNew)
    debugLog(`📤 [UPLOAD_TRACKING] Sending request to Amazon...`, 'info');
    const requestStartTime = Date.now();

    let response;
    let currentEndpointIndex = 0;

    // Try multiple endpoints if first one fails with 404
    while (currentEndpointIndex < uploadEndpoints.length) {
      uploadUrl = uploadEndpoints[currentEndpointIndex];

      if (currentEndpointIndex > 0) {
        debugLog(`🔄 [UPLOAD_TRACKING] Trying alternative endpoint ${currentEndpointIndex + 1}: ${uploadUrl}`, 'info');
        log(`🔄 Trying alternative endpoint ${currentEndpointIndex + 1}: ${uploadUrl}`);
      }

      response = await requestOnce(uploadUrl, {
        method: 'POST',
        body: formData
      });

      // If not 404, break (either success or other error)
      if (response.status !== 404) {
        break;
      }

      debugLog(`❌ [UPLOAD_TRACKING] Endpoint ${currentEndpointIndex + 1} returned 404, trying next...`, 'error');
      log(`❌ Endpoint ${currentEndpointIndex + 1} returned 404, trying next...`);
      currentEndpointIndex++;
      return;
    }

    const requestEndTime = Date.now();
    const requestDuration = requestEndTime - requestStartTime;

    console.log(`[UPLOAD_TRACKING] Response status: ${response.status}`);
    debugLog(`📡 [UPLOAD_TRACKING] Amazon Response: ${response.status} ${response.statusText} (${requestDuration}ms)`,
      response.ok ? 'success' : 'error');
    debugLog(`📡 [UPLOAD_TRACKING] Final endpoint used: ${uploadUrl}`, 'info');
    log(`📡 Final endpoint used: ${uploadUrl} - Status: ${response.status}`);

    // Log response headers for debugging
    debugLog(`📋 [UPLOAD_TRACKING] Response headers:`, 'info');
    for (const [key, value] of response.headers.entries()) {
      debugLog(`  - ${key}: ${value}`, 'info');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      debugLog(`❌ [UPLOAD_TRACKING] Error Response Body: ${errorText.slice(0, 500)}`, 'error');
      log(`❌ [UPLOAD_TRACKING] Error Response Body: ${errorText.slice(0, 500)}`);
      debugLog(`❌ [UPLOAD_TRACKING] Full Error Details:`, 'error');
      debugLog(`  - Status: ${response.status}`, 'error');
      debugLog(`  - Status Text: ${response.statusText}`, 'error');
      debugLog(`  - URL: ${response.url}`, 'error');
      debugLog(`  - Response Size: ${errorText.length} chars`, 'error');
      log(`❌ Upload failed: ${response.status} ${response.statusText}`);

      // Debug: Check if response is HTML (indicates redirect/login page)
      if (errorText.includes('<!doctype html>') || errorText.includes('<html')) {
        debugLog(`🔍 [UPLOAD_TRACKING] Response is HTML - likely redirect to login page`, 'error');
        log(`🔍 Response is HTML - likely redirect to login page`);
        debugLog(`🔍 [UPLOAD_TRACKING] HTML title check...`, 'error');

        const titleMatch = errorText.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
          debugLog(`📄 [UPLOAD_TRACKING] Page title: ${titleMatch[1]}`, 'error');
          log(`📄 Page title: ${titleMatch[1]}`);
        }

        // Check for login indicators
        if (errorText.includes('sign-in') || errorText.includes('login') || errorText.includes('authentication')) {
          debugLog(`🔐 [UPLOAD_TRACKING] Login required - session expired`, 'error');
          log(`🔐 Login required - session expired`);
        }
      }

      // Check for specific error types
      let errorType = 'UNKNOWN_ERROR';
      if (response.status === 403) {
        errorType = 'CSRF_TOKEN_ERROR';
        debugLog(`� [UPLOAD_TRACKING] CSRF Token error detected - may need to refresh session`, 'error');
      } else if (response.status === 401) {
        errorType = 'AUTHENTICATION_ERROR';
        debugLog(`� [UPLOAD_TRACKING] Authentication error - session may have expired`, 'error');
      } else if (response.status === 400) {
        errorType = 'BAD_REQUEST';
        debugLog(`📝 [UPLOAD_TRACKING] Bad request - check file format or parameters`, 'error');
      } else if (response.status === 500) {
        errorType = 'SERVER_ERROR';
        debugLog(`🔥 [UPLOAD_TRACKING] Amazon server error`, 'error');
      }

      const error = new Error(`Amazon upload failed with status ${response.status}: ${errorText.slice(0, 200)}`);
      error.code = errorType;
      error.status = response.status;
      error.responseText = errorText;

      // Log upload failed with extension logger
      if (extensionLogger) {
        await extensionLogger.logUploadFailed({
          filename: fileObj.name,
          fileSize: fileObj.size,
          progress: 0,
          ordersUploaded: 0
        }, {
          taskId: `upload_${startTime}`,
          taskType: 'UPLOAD_TRACKING',
          batchId: uploadParams?.batchId || `upload_${startTime}`
        }, error, 'Amazon upload failed');
      }

      throw error;
    }

    // Parse response (same pattern as requestReferenceIdNew)
    let result;
    const contentType = response.headers.get('content-type') || '';
    debugLog(`📄 [UPLOAD_TRACKING] Response content-type: ${contentType}`, 'info');

    if (isJson(response)) {
      result = await response.json();
      debugLog(`📄 [UPLOAD_TRACKING] Response parsed as JSON:`, 'info');
      debugLog(`  - Keys: ${Object.keys(result).join(', ')}`, 'info');
      if (result.success !== undefined) {
        debugLog(`  - Success: ${result.success}`, result.success ? 'success' : 'error');
      }
      if (result.message) {
        debugLog(`  - Message: ${result.message}`, 'info');
      }
    } else {
      result = await response.text();
      debugLog(`📄 [UPLOAD_TRACKING] Response parsed as text (${result.length} chars):`, 'info');
      debugLog(`  - Preview: ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`, 'info');
    }

    console.log(`[UPLOAD_TRACKING] Upload successful:`, result);
    debugLog(`✅ [UPLOAD_TRACKING] Upload successful!`, 'success');
    debugLog(`📊 [UPLOAD_TRACKING] Upload summary:`, 'success');
    debugLog(`  - File: ${fileObj.name}`, 'success');
    debugLog(`  - Size: ${fileObj.size} bytes`, 'success');
    debugLog(`  - Duration: ${Date.now() - startTime}ms`, 'success');
    debugLog(`  - Response type: ${typeof result}`, 'success');

    const endTime = Date.now();

    // Log upload completed with extension logger
    if (extensionLogger) {
      await extensionLogger.logUploadCompleted({
        filename: fileObj.name,
        fileSize: fileObj.size,
        progress: 100,
        ordersUploaded: uploadParams?.ordersCount || 0
      }, {
        taskId: `upload_${startTime}`,
        taskType: 'UPLOAD_TRACKING',
        batchId: uploadParams?.batchId || `upload_${startTime}`
      }, {
        duration: endTime - startTime,
        memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
        cpuUsage: 0
      }, 'Amazon upload completed successfully');
    }

    // Log success
    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "success",
      message: `✅ Upload tracking file ${fileObj.name} to Amazon success!`
    });

    return { success: true, result };

  } catch (error) {
    console.error(`[UPLOAD_TRACKING] Upload error:`, error);
    debugLog(`❌ [UPLOAD_TRACKING] Upload failed with error:`, 'error');
    debugLog(`  - Error type: ${error.constructor.name}`, 'error');
    debugLog(`  - Error message: ${error.message}`, 'error');
    debugLog(`  - Error code: ${error.code || 'N/A'}`, 'error');
    debugLog(`  - HTTP status: ${error.status || 'N/A'}`, 'error');
    if (error.stack) {
      debugLog(`  - Stack trace: ${error.stack.split('\n')[0]}`, 'error');
    }

    // Log error with extension logger
    if (extensionLogger) {
      await extensionLogger.logUploadFailed({
        filename: fileObj.name,
        fileSize: fileObj.size,
        progress: 0,
        ordersUploaded: 0
      }, {
        taskId: `upload_${startTime}`,
        taskType: 'UPLOAD_TRACKING',
        batchId: uploadParams?.batchId || `upload_${startTime}`
      }, error, 'Amazon upload failed with error');
    }

    // Log error
    await postLogSingle({
      base,
      token: (await getCfg()).ingestToken,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: "error",
      message: `❌ Upload tracking file ${fileObj.name} to Amazon failed: ${error.message}`
    });

    throw error;
  }
}


async function reportUploadResult(batchId, status, errorMessage = null) {
  const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();
  log(`[UPLOAD_TRACKING] Reporting upload result for batch ${batchId}: ${status}${errorMessage ? " - " + errorMessage : ""}`);
  try {
    const reportData = {
      batchId,
      status, // 'success' | 'failed'
      timestamp: new Date().toISOString(),
      machineId: clientId,
      label: clientLabel,
      shopId
    };

    if (errorMessage) {
      reportData.error = errorMessage;
    }

    // Report back to server via Socket.IO
    if (socket && socket.connected) {
      socket.emit('upload:result', reportData);
      console.log(`[UPLOAD_TRACKING] Reported ${status} for batch ${batchId}`);
    }

    // Also log via standard logging
    await postLogSingle({
      base,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: "auto",
      level: status === 'success' ? "success" : "error",
      message: status === 'success'
        ? `✅ Upload tracking batch ${batchId} success!`
        : `❌ Upload tracking batch ${batchId} failed: ${errorMessage}`
    });

  } catch (error) {
    console.error(`[UPLOAD_TRACKING] Failed to report result:`, error);
  }
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

  // Initialize logger if not exists
  if (!extensionLogger) {
    await initializeLogger();
  }

  // Log task processing start
  if (extensionLogger) {
    await extensionLogger.logTaskProcessing({
      taskId: `import_orders_${Date.now()}`,
      taskType: 'IMPORT_ORDERS',
      batchId: `import_orders_${Date.now()}`,
      ordersCount: 0
    }, `Starting full import flow (trigger: ${trigger})`);
  }

  try {
    try {
      await runImportNewOrders(undefined);
      phases.push({ type: "import", status: "success" });

      // Log task completed
      if (extensionLogger) {
        const endTime = Date.now();
        await extensionLogger.logTaskCompleted({
          taskId: `import_orders_${startTime}`,
          taskType: 'IMPORT_ORDERS',
          batchId: `import_orders_${startTime}`,
          ordersCount: 0
        }, {
          duration: endTime - startTime,
          memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
          cpuUsage: 0
        }, 'Import orders completed successfully');
      }

    } catch (error) {
      phases.push({ type: "import", status: "fail" });

      // Log task failed
      if (extensionLogger) {
        await extensionLogger.logTaskFailed({
          taskId: `import_orders_${startTime}`,
          taskType: 'IMPORT_ORDERS',
          batchId: `import_orders_${startTime}`,
          ordersCount: 0
        }, error, 'Import orders failed');
      }
    }

    await postLogSingle({
      base,
      shopId,
      machineId: clientId,
      label: clientLabel,
      action: trigger,
      level: "success",
      message: "✅ Import order success!",
    });
  } catch (e) {
    console.log(e);

    // Log general error
    if (extensionLogger) {
      await extensionLogger.logError(e, {
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
      message: "❌ Import order error!",
    });
  }

  return { ok: true, phases };
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

  const current = await chrome.storage.local.get(ADS_HEADER_STORAGE_KEYS);
  const merged = { ...current, ...clean };
  const changed = keys.some((k) => clean[k] && clean[k] !== current[k]);
  const hasCoreHeaders = isAdsHeaderComplete(merged);
  const now = Date.now();

  // Nếu Amazon vẫn gửi cùng token cũ, vẫn update lastSeen để chứng minh session còn sống.
  if (!changed && hasCoreHeaders && now - lastAdsHeaderWriteAt < 5000) return;

  const payload = { ...clean };
  if (hasCoreHeaders) payload.adsHeaderLastSeen = now;

  await chrome.storage.local.set(payload);
  lastAdsHeaderWriteAt = now;

  log("[ADS] headers captured:", keys.join(", "));
  extensionLogger?.logInfo("[ADS-AUTH] Ads headers captured", {
    keys,
    changed,
    hasCoreHeaders,
    lastSeen: payload.adsHeaderLastSeen,
  });
}

/* ===============================
   Đảm bảo CSRF headers còn hạn trước khi gọi Ads API
   - Nếu headers chưa có hoặc > 30 phút → mở tab ads, đợi capture xong
   =============================== */
const ADS_HEADER_TTL_MS = 20 * 60 * 1000; // giảm TTL để hạn chế token cũ gây 401

async function forceRefreshAdsHeaders(reason = "manual") {
  const startedAt = Date.now();
  debugLog(`🔄 [ADS-AUTH] Force refresh Ads headers — reason: ${reason}`, "info");
  extensionLogger?.logInfo("[ADS-AUTH] Force refresh Ads headers", { reason });

  await clearAdsHeaders(reason);

  const tabId = await ensureAdsTab();

  // Navigate về trang Campaigns, inject sniffer, rồi reload để bắt request gốc sau khi sniffer đã sẵn sàng.
  await chrome.tabs.update(tabId, { url: `${ADS_BASE}/cm/campaigns`, active: true });
  await waitForAdsTabComplete(tabId);
  await ensureAdsBridgeInjected(tabId);

  await chrome.tabs.reload(tabId);
  await waitForAdsTabComplete(tabId);
  await ensureAdsBridgeInjected(tabId);
  await delayMs(ADS_PAGE_SETTLE_MS);

  let captured = await waitForAdsHeaderCapture({ since: startedAt });

  if (!captured) {
    // Lần dự phòng: nhiều khi Amazon Ads lazy-load sau vài giây hoặc cần thêm reload.
    debugLog("🔁 [ADS-AUTH] First refresh did not capture headers, retrying once...", "info");
    await chrome.tabs.reload(tabId);
    await waitForAdsTabComplete(tabId);
    await ensureAdsBridgeInjected(tabId);
    await delayMs(ADS_PAGE_SETTLE_MS + 1500);
    captured = await waitForAdsHeaderCapture({ since: startedAt, timeoutMs: ADS_HEADER_REFRESH_TIMEOUT_MS });
  }

  const latest = await readAdsHeaderState();
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
    : "Không capture được Ads headers từ Amazon Ads page.";

  throw createAdsError(`Không thể refresh Ads headers: ${reasonText}`, 401, JSON.stringify(hint).slice(0, 1000));
}

async function ensureFreshAdsHeaders({ force = false, reason = "preflight" } = {}) {
  const st = await readAdsHeaderState();
  const age = st.adsHeaderLastSeen ? Date.now() - Number(st.adsHeaderLastSeen) : Infinity;
  const isValid = isAdsHeaderComplete(st) && age < ADS_HEADER_TTL_MS;

  debugLog(`🔑 [ADS-AUTH] Header status: ${isValid ? "valid" : "expired/missing"} — age ${Math.round(age / 1000)}s`, isValid ? "info" : "error");
  extensionLogger?.logInfo("[ADS-AUTH] Header preflight", {
    force,
    reason,
    isValid,
    ageSeconds: Math.round(age / 1000),
    hasAccountId: !!st.adsAccountId,
    hasAdvertiserId: !!st.adsAdvertiserId,
    hasClientId: !!st.adsClientId,
    hasMarketplaceId: !!st.adsMarketplaceId,
    hasCsrfData: !!st.adsCsrfData,
    hasCsrfToken: !!st.adsCsrfToken,
  });

  if (!force && isValid) return true;
  return forceRefreshAdsHeaders(reason);
}


chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      if (!details?.url?.startsWith(ADS_BASE)) return;
      const found = collectAdsHeaders(details.requestHeaders || []);
      saveAdsHeadersIfAny(found);
    } catch { }
  },
  { urls: [`${ADS_BASE}/*`] },
  ["requestHeaders", "extraHeaders"]
);

/* =========================
   ADS — Check Campaign Names (using your existing bridge)
   ========================= */

function todayYMD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchEmployeeCodes() {
  const { ingestUrl } = await getCfg();
  const { getSeller } = deriveApiUrls(ingestUrl);
  try {
    const response = await fetch(getSeller, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Invalid response format, expected an array");
    }

    console.log("✅ Danh sách mã nhân viên:", data);
    return data; // Ví dụ: ["J2501","J2502","J2503",...]
  } catch (error) {
    console.error("❌ Lỗi khi lấy mã nhân viên:", error.message);
    return [];
  }
}

// background.js (hoặc module dùng để kiểm tra)
function checkInvalidCampaignNames(campaigns, employeeCodes) {
  // chuẩn hoá allowed: Set uppercase
  const allowed = new Set(
    (employeeCodes || []).map((c) => String(c).trim().toUpperCase())
  );

  // helper: lấy prefix hợp lệ dạng 1 chữ + 4 số ở đầu chuỗi
  function extractPrefix5(name) {
    if (!name) return "";
    const s = String(name).trim();
    const m = s.match(/^([A-Za-z]\d{4})/); // ^: ngay đầu chuỗi
    return m ? m[1].toUpperCase() : ""; // VD: "J2501"
  }

  let totalChecked = 0;
  const invalidList = [];

  for (const c of campaigns || []) {
    const name = (c.campaignName ?? c.name ?? "").trim();
    if (!name) continue;
    totalChecked++;

    const prefix = extractPrefix5(name);
    const isValid = prefix && allowed.has(prefix);

    if (!isValid) {
      invalidList.push({
        name,
        state: c.state || c.status || "Unknown",
        prefixFound: prefix || null,
      });
    }
  }

  return {
    ok: true,
    total: totalChecked,
    invalidCount: invalidList.length,
    invalidList,
  };
}

async function checkCampaign(date) {
  if (!date) throw new Error("date (YYYY-MM-DD) required");
  const employeeCodes = await fetchEmployeeCodes();
  const rows = await fetchAllCampaignSpend(date, date, 300, true);

  const result = checkInvalidCampaignNames(rows, employeeCodes);

  return {
    ok: true,
    totalChecked: result?.total,
    invalidCount: result?.invalidCount,
    invalidList: result?.invalidList,
  };
}

/* ================================================================
   SOCKET.IO AUTO CONNECT + KEEPALIVE (Realtime only)
   ================================================================ */

let socket = null;
let hbTimer = null;
let connectBusy = false;
let heartbeatInterval = null;

// Auto reconnect polling
let autoReconnectInterval = null;

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
  if (connectBusy) {
    console.log('[SOCKET-LOG] Connection already in progress, skipping...');
    if (extensionLogger) {
      await extensionLogger.logConnectionStatus('busy', { force }, 'Socket connection already in progress');
    }
    return { ok: false, reason: "busy" };
  }
  connectBusy = true;

  try {
    const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();

    console.log('[SOCKET-LOG] Starting socket connection...', { base, shopId, clientId, clientLabel, force });
    if (extensionLogger) {
      await extensionLogger.logConnectionStatus('connecting', {
        base, shopId, clientId, clientLabel, force
      }, 'Initiating Socket.IO connection');
    }

    if (!base) {
      console.error('[SOCKET-LOG] Missing base URL');
      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('failed', { reason: 'base_missing' }, 'Socket connection failed: Missing base URL');
      }
      return { ok: false, reason: "base missing" };
    }

    if (!shopId) {
      console.error('[SOCKET-LOG] Missing shopId');
      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('failed', { reason: 'shopid_missing' }, 'Socket connection failed: Missing shopId');
      }
      return { ok: false, reason: "shopId missing" };
    }

    // Nếu đã connected và không force → bỏ qua
    if (!force && socket?.connected) {
      console.log('[SOCKET-LOG] Already connected, skipping reconnection');
      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('already_connected', { socketId: socket.id }, 'Socket already connected');
      }
      return { ok: true, message: "already connected" };
    }

    // Ngắt socket cũ nếu có
    if (socket) {
      console.log('[SOCKET-LOG] Disconnecting existing socket...');
      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('disconnecting_old', {
          oldSocketId: socket.id,
          oldConnected: socket.connected
        }, 'Disconnecting existing socket connection');
      }
      try { socket.disconnect(); } catch { }
      socket = null;
      stopHeartbeat();

      // Dừng test connection polling khi cleanup socket
      stopTestConnectionPolling();

      // Dừng auto reconnect polling khi cleanup socket
      stopAutoReconnectPolling();
    }

    console.log('[SOCKET-LOG] Creating new socket connection...', {
      url: base,
      path: '/ws',
      auth: { shopId, machineId: clientId, label: clientLabel }
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

    // Khi kết nối thành công
    socket.on("connect", async () => {
      console.log("[SOCKET-LOG] ✅ Connected successfully!", { socketId: socket.id, timestamp: new Date().toISOString() });

      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('connected', {
          socketId: socket.id,
          timestamp: new Date().toISOString(),
          reconnectionAttempts: socket.io.reconnectionAttempts || 0
        }, 'Socket.IO connection established successfully');
      }

      await postLogSingle({
        base, shopId, machineId: clientId, label: clientLabel,
        action: "auto", level: "success",
        message: "✅ Extension connected to Socket.IO",
      });
      startHeartbeat();

      // Bắt đầu test connection polling khi socket kết nối
      startTestConnectionPolling();

      // Bắt đầu auto reconnect polling khi socket kết nối
      startAutoReconnectPolling();

      // Bắt đầu auto config scheduler
      startAutoConfigScheduler();
      startAutoConfigSync();
    });

    // Khi mất kết nối
    socket.on("disconnect", async (reason) => {
      console.log("[SOCKET-LOG] ❌ Disconnected:", { reason, timestamp: new Date().toISOString() });

      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('disconnected', {
          reason,
          timestamp: new Date().toISOString(),
          wasConnected: true
        }, `Socket disconnected: ${reason}`);
      }

      await postLogSingle({
        base, shopId, machineId: clientId, label: clientLabel,
        action: "auto", level: "error",
        message: `❌ Socket disconnected: ${reason}`,
      });
      stopHeartbeat();

      // Dừng test connection polling khi socket ngắt kết nối
      stopTestConnectionPolling();

      // Dừng auto reconnect polling khi socket ngắt kết nối
      stopAutoReconnectPolling();

      // Nếu server ép disconnect → force reconnect ngay
      if (reason === "io server disconnect") {
        console.log("[SOCKET-LOG] Server forced disconnect, attempting reconnection...");
        if (extensionLogger) {
          await extensionLogger.logConnectionStatus('reconnecting', {
            reason: 'server_disconnect'
          }, 'Server forced disconnect, initiating reconnection');
        }
        connectSocketIO(true);
      }
    });

    // Connection error handling
    socket.on("connect_error", async (error) => {
      console.error("[SOCKET-LOG] ❌ Connection error:", error);

      if (extensionLogger) {
        await extensionLogger.logError(error, {
          socketUrl: base,
          shopId,
          clientId,
          timestamp: new Date().toISOString()
        }, 'Socket.IO connection error');
      }
    });

    // Reconnection events
    socket.on("reconnect", async (attemptNumber) => {
      console.log("[SOCKET-LOG] ✅ Reconnected after", attemptNumber, "attempts");

      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('reconnected', {
          attemptNumber,
          timestamp: new Date().toISOString()
        }, `Successfully reconnected after ${attemptNumber} attempts`);
      }
    });

    socket.on("reconnect_attempt", async (attemptNumber) => {
      console.log("[SOCKET-LOG] 🔄 Reconnection attempt", attemptNumber);

      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('reconnect_attempt', {
          attemptNumber,
          timestamp: new Date().toISOString()
        }, `Reconnection attempt #${attemptNumber}`);
      }
    });

    socket.on("reconnect_failed", async () => {
      console.error("[SOCKET-LOG] ❌ Reconnection failed after all attempts");

      if (extensionLogger) {
        await extensionLogger.logConnectionStatus('reconnect_failed', {
          timestamp: new Date().toISOString()
        }, 'Socket reconnection failed after all attempts');
      }
    });

    // Heartbeat tự động
    function startHeartbeat() {
      stopHeartbeat();
      console.log("[SOCKET-LOG] 💓 Starting heartbeat...");
      heartbeatInterval = setInterval(() => {
        if (socket?.connected) {
          socket.emit("heartbeat", { ts: Date.now() });
          console.log("[SOCKET-LOG] 💓 Heartbeat sent");
        }
      }, 30000); // 30s gửi 1 ping
    }

    function stopHeartbeat() {
      if (heartbeatInterval) {
        console.log("[SOCKET-LOG] 💔 Stopping heartbeat...");
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }

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

    //           // 2. Upload lên platform ngay lập tức
    //           uploadToAmazon(fileObj, uploadParams).then(() => {
    //             console.log(`✅ Successfully uploaded ${file.filename}`);
    //             // Optional: Báo cáo kết quả về server
    //             reportUploadResult(payload.batchId, 'success');
    //           }).catch(error => {
    //             console.error(`❌ Failed to upload ${file.filename}:`, error);
    //             reportUploadResult(payload.batchId, 'failed', error.message);
    //           });
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

    return { ok: true };
  } finally {
    connectBusy = false;
  }
}

/* ===============================
   handleServerTask — dùng chung cho socket & test
   =============================== */
async function handleServerTask(task) {
  console.log('📨 [EXT-DEBUG] ===== RECEIVED SERVER TASK =====');
  console.log('⏰ [EXT-DEBUG] Timestamp:', new Date().toISOString());
  console.log('🔍 [EXT-DEBUG] Raw task object:', JSON.stringify(task, null, 2));

  const { type, payload } = task || {};
  console.log('🏷️ [EXT-DEBUG] Task type:', type);
  console.log('📦 [EXT-DEBUG] Payload keys:', Object.keys(payload || {}));
  log(`✅ [EXT-DEBUG] Connected to server`, payload);
  log(`🆔 [EXT-DEBUG] Socket ID:`, socket.id);
  log('🔗 [EXT-DEBUG] Socket connected:', socket.connected);

  const authData = {
    shopId: "your_shop_id",
    machineId: "your_machine_id",
    label: "Extension Name",
    version: "1.0.0"
  };
  log('🔑 [EXT-DEBUG] Auth data being sent:', authData);
  log(`[SOCKET] Received task from server: ${type}`, payload);
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

  try {
    switch (type) {
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
          await runFullFlowAndEmitLogs("click");

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
        if (!payload?.date) throw new Error("Missing payload.date");
        console.log('📅 [EXT-DEBUG] Ads spend date:', payload.date);

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

        try {
          await runExportAdsSpend(payload.date);

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

        // Initialize logger if not exists
        if (!extensionLogger) {
          await initializeLogger();
        }

        const uploadTaskId = payload?.batchId || `upload_${Date.now()}`;
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

          uploadToAmazon(fileObj, uploadParams)
            .then(async () => {
              console.log(`✅ [EXT-DEBUG] Successfully uploaded ${file.filename}`);
              console.log('📝 [EXT-DEBUG] Reporting success to server...');

              // Log task completed
              if (extensionLogger) {
                const uploadEndTime = Date.now();
                await extensionLogger.logTaskCompleted({
                  taskId: uploadTaskId,
                  taskType: type,
                  batchId: payload?.batchId,
                  ordersCount: payload?.trackingData?.length || 0,
                  filename: payload?.file?.filename
                }, {
                  duration: uploadEndTime - uploadStartTime,
                  memoryUsage: performance.memory?.usedJSHeapSize / 1024 / 1024,
                  cpuUsage: 0
                }, `[UPLOAD_TRACKING] Upload tracking completed successfully: ${file.filename}`);
              }

              // Optional: Báo cáo kết quả về server
              reportUploadResult(payload.batchId, 'success');
            })
            .catch(async error => {
              console.error(`❌ [EXT-DEBUG] Failed to upload ${file.filename}:`, error);
              console.log('📝 [EXT-DEBUG] Reporting failure to server...');

              // Log task failed
              if (extensionLogger) {
                await extensionLogger.logTaskFailed({
                  taskId: uploadTaskId,
                  taskType: type,
                  batchId: payload?.batchId,
                  ordersCount: payload?.trackingData?.length || 0,
                  filename: payload?.file?.filename
                }, error, `[UPLOAD_TRACKING] Upload tracking failed: ${file.filename}`);
              }

              reportUploadResult(payload.batchId, 'failed', error.message);
            });

          console.log('🎯 [EXT-DEBUG] Upload initiated, waiting for result...');
        } else {
          console.log('⚠️ [EXT-DEBUG] Non-auto-generated UPLOAD_TRACKING task, skipping...');
        }
        break;

      default:
        console.log('❓ [EXT-DEBUG] Unknown task type:', type);
        break;
    }

    console.log('✅ [EXT-DEBUG] Task processing completed successfully');

  } catch (e) {
    console.error("❌ [EXT-DEBUG] Task processing error:", e?.message || e);
    console.error("📋 [EXT-DEBUG] Error stack:", e?.stack);
    console.error("📦 [EXT-DEBUG] Task that caused error:", { type, payload });

    // Report error for UPLOAD_TRACKING tasks
    if (type === "UPLOAD_TRACKING" && payload?.batchId) {
      console.log('📝 [EXT-DEBUG] Reporting task error to server...');
      try {
        await reportUploadResult(payload.batchId, 'failed', e?.message || 'Unknown error');
      } catch (reportError) {
        console.error('❌ [EXT-DEBUG] Failed to report error:', reportError);
      }
    }
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
        debugLog(`🔑 [CSRF-TEST] CSRF Token found with pattern ${i + 1}: ${csrfToken.slice(0, 20)}...`, 'success');
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
        debugLog(`🍪 [CSRF-TEST] Found CSRF token in cookie: ${cookieToken.slice(0, 20)}...`, 'info');
        csrfToken = cookieToken;
      } else {
        debugLog(`❌ [CSRF-TEST] No CSRF token in cookie either`, 'error');
      }
    }

    // Test with a sample upload (dry run)
    if (csrfToken) {
      debugLog(`✅ [CSRF-TEST] CSRF Token ready for upload: ${csrfToken.slice(0, 30)}...`, 'success');

      // Show what the FormData would look like
      debugLog(`📋 [CSRF-TEST] FormData would include:`, 'info');
      debugLog(`  - feedFile: [Binary File]`, 'info');
      debugLog(`  - feedName: confirmShipment`, 'info');
      debugLog(`  - feedVersion: new`, 'info');
      debugLog(`  - csrfToken: ${csrfToken.slice(0, 30)}...`, 'info');
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
      debugLog(`  - Socket connected: ${socket.connected}`, socket.connected ? 'success' : 'error');
      debugLog(`  - Socket ID: ${socket.id}`, 'info');
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

/* ===============================
   AUTO CONFIG SCHEDULER
   Đọc config từ storage, tạo interval cho từng task
   =============================== */

const autoConfigTimers = {};

function yesterdayYMD() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function startAutoConfigScheduler() {
  stopAutoConfigScheduler();
  if (!extensionLogger) await initializeLogger();

  const { ingestUrl, shopId } = await getCfg();
  if (!ingestUrl || !shopId) {
    debugLog("⚙️ [AUTO-CFG] No ingestUrl or shopId, skipping scheduler", "info");
    return;
  }

  // Debounce: tránh gọi liên tiếp trong 3 giây
  const now = Date.now();
  if (startAutoConfigScheduler._lastRun && now - startAutoConfigScheduler._lastRun < 3000) {
    debugLog("⚙️ [AUTO-CFG] Debounced duplicate call, skipping", "info");
    return;
  }
  startAutoConfigScheduler._lastRun = now;

  let records = [];
  try {
    const res = await fetch(`${ingestUrl}/api/auto-config?shopId=${shopId}`);
    const json = await res.json();
    if (!json.success) throw new Error("API returned success=false");
    records = (json.data || []).filter(r => r.shopId === shopId);
    debugLog(`⚙️ [AUTO-CFG] Loaded ${records.length} configs from API`, "info");
    extensionLogger?.logInfo("[AUTO-CFG] Scheduler starting", { total: records.length });
    // Lưu snapshot để sync timer so sánh
    _lastAutoConfigSnapshot = JSON.stringify(records.map(r => ({ type: r.type, status: r.status, time: r.time })));
  } catch (e) {
    debugLog(`❌ [AUTO-CFG] Failed to load config from API: ${e.message}`, "error");
    return;
  }

  const ALL_TYPES = ["IMPORT_ORDER", "IMPORT_FBM", "IMPORT_ADS", "UPLOAD_TRACKING"];
  const activeTypes = records.filter(r => r.status === true).map(r => r.type);

  // Log tất cả types — cả enabled lẫn disabled
  for (const type of ALL_TYPES) {
    const record = records.find(r => r.type === type);
    if (!record || record.status !== true) {
      const time = record ? record.time : "N/A";
      debugLog(`⏸️ [AUTO-CFG] ${type} — status: OFF — interval: ${time} min`, "info");
      extensionLogger?.logInfo(`[AUTO-CFG] ${type} disabled`, { time });
    }
  }

  for (const record of records.filter(r => r.status === true)) {
    const mins = parseInt(record.time) || 60;
    const ms = mins * 60 * 1000;

    if (record.type === "IMPORT_ORDER") {
      debugLog(`✅ [AUTO-CFG] IMPORT_ORDERS — status: ON — interval: ${mins} min`, "success");
      extensionLogger?.logInfo("[AUTO-CFG] IMPORT_ORDERS enabled", { intervalMin: mins });
      autoConfigTimers.orders = setInterval(async () => {
        const ts = new Date().toLocaleTimeString();
        debugLog(`🔄 [AUTO-CFG] IMPORT_ORDERS tick — ${ts}`, "info");
        try {
          await handleServerTask({ type: "IMPORT_ORDERS", payload: {} });
          debugLog("✅ [AUTO-CFG] IMPORT_ORDERS completed", "success");
        } catch (e) {
          debugLog(`❌ [AUTO-CFG] IMPORT_ORDERS error: ${e.message}`, "error");
        }
      }, ms);

    } else if (record.type === "IMPORT_FBM") {
      debugLog(`✅ [AUTO-CFG] IMPORT_FBM_ORDERS — status: ON — interval: ${mins} min`, "success");
      extensionLogger?.logInfo("[AUTO-CFG] IMPORT_FBM_ORDERS enabled", { intervalMin: mins });
      autoConfigTimers.fbm = setInterval(async () => {
        const ts = new Date().toLocaleTimeString();
        debugLog(`🔄 [AUTO-CFG] IMPORT_FBM_ORDERS tick — ${ts}`, "info");
        try {
          await handleServerTask({ type: "IMPORT_FBM_ORDERS", payload: {} });
          debugLog("✅ [AUTO-CFG] IMPORT_FBM_ORDERS completed", "success");
        } catch (e) {
          debugLog(`❌ [AUTO-CFG] IMPORT_FBM_ORDERS error: ${e.message}`, "error");
        }
      }, ms);

    } else if (record.type === "IMPORT_ADS") {
      debugLog(`✅ [AUTO-CFG] IMPORT_ADS_SPEND — status: ON — interval: ${mins} min`, "success");
      extensionLogger?.logInfo("[AUTO-CFG] IMPORT_ADS_SPEND enabled", { intervalMin: mins });
      autoConfigTimers.ads = setInterval(async () => {
        const date = yesterdayYMD();
        const ts = new Date().toLocaleTimeString();
        debugLog(`🔄 [AUTO-CFG] IMPORT_ADS_SPEND tick — date: ${date} — ${ts}`, "info");
        try {
          await handleServerTask({ type: "IMPORT_ADS_SPEND", payload: { date } });
          debugLog(`✅ [AUTO-CFG] IMPORT_ADS_SPEND completed for ${date}`, "success");
        } catch (e) {
          debugLog(`❌ [AUTO-CFG] IMPORT_ADS_SPEND error: ${e.message}`, "error");
        }
      }, ms);

    } else if (record.type === "UPLOAD_TRACKING") {
      debugLog(`✅ [AUTO-CFG] UPLOAD_TRACKING — status: ON — interval: ${mins} min`, "success");
      extensionLogger?.logInfo("[AUTO-CFG] UPLOAD_TRACKING enabled", { intervalMin: mins });
      autoConfigTimers.upload = setInterval(async () => {
        const ts = new Date().toLocaleTimeString();
        debugLog(`🔄 [AUTO-CFG] UPLOAD_TRACKING tick — ${ts}`, "info");
        try {
          await uploadtracking();
          debugLog("✅ [AUTO-CFG] UPLOAD_TRACKING completed", "success");
        } catch (e) {
          debugLog(`❌ [AUTO-CFG] UPLOAD_TRACKING error: ${e.message}`, "error");
        }
      }, ms);
    }
  }

  debugLog("⚙️ [AUTO-CFG] Scheduler started", "success");
}

function stopAutoConfigScheduler() {
  for (const [key, timer] of Object.entries(autoConfigTimers)) {
    clearInterval(timer);
    delete autoConfigTimers[key];
    debugLog(`🛑 [AUTO-CFG] Stopped timer: ${key}`, "info");
    extensionLogger?.logInfo(`[AUTO-CFG] Timer stopped: ${key}`);
  }
}

// ── Auto sync config từ API mỗi 10 phút ──
let _autoConfigSyncTimer = null;
let _lastAutoConfigSnapshot = null;

async function startAutoConfigSync() {
  if (_autoConfigSyncTimer) clearInterval(_autoConfigSyncTimer);

  debugLog("🔁 [AUTO-CFG-SYNC] Started — will re-check API every 10 min", "info");

  _autoConfigSyncTimer = setInterval(async () => {
    try {
      const { ingestUrl, shopId } = await getCfg();
      if (!ingestUrl || !shopId) return;

      debugLog("🔁 [AUTO-CFG-SYNC] Checking for config changes...", "info");

      const res = await fetch(`${ingestUrl}/api/auto-config?shopId=${shopId}`);
      const json = await res.json();
      if (!json.success) return;

      const records = (json.data || []).filter(r => r.shopId === shopId);
      const snapshot = JSON.stringify(records.map(r => ({ type: r.type, status: r.status, time: r.time })));

      if (snapshot === _lastAutoConfigSnapshot) {
        debugLog("✅ [AUTO-CFG-SYNC] No changes detected", "info");
        return;
      }

      debugLog("⚠️ [AUTO-CFG-SYNC] Config changed — restarting scheduler...", "info");
      _lastAutoConfigSnapshot = snapshot;

      // Log chi tiết thay đổi
      const active = records.filter(r => r.status === true);
      const inactive = records.filter(r => r.status !== true);
      active.forEach(r => debugLog(`  ✅ ${r.type} — ON — ${r.time} min`, "success"));
      inactive.forEach(r => debugLog(`  ⏸️ ${r.type} — OFF — ${r.time} min`, "info"));

      await startAutoConfigScheduler();
      debugLog("✅ [AUTO-CFG-SYNC] Scheduler restarted with new config", "success");
    } catch (e) {
      debugLog(`❌ [AUTO-CFG-SYNC] Error: ${e.message}`, "error");
    }
  }, 10 * 60 * 1000);
}

function stopAutoConfigSync() {
  if (_autoConfigSyncTimer) {
    clearInterval(_autoConfigSyncTimer);
    _autoConfigSyncTimer = null;
    debugLog("🛑 [AUTO-CFG-SYNC] Stopped", "info");
  }
}

// Bắt đầu polling connection status report mỗi 3 phút
function startTestConnectionPolling() {
  // Dừng polling cũ nếu có
  stopTestConnectionPolling();

  if (extensionLogger) {
    extensionLogger.logInfo('Connection status polling started', { interval: '3min' });
  }

  // Report status ngay lập tức
  testConnection();

  // Sau đó report mỗi 3 phút
  testConnectionInterval = setInterval(() => {
    testConnection();
  }, 180000); // 3 phút = 180000ms
}

// Dừng polling connection status report
function stopTestConnectionPolling() {
  if (testConnectionInterval) {
    if (extensionLogger) {
      extensionLogger.logInfo('Connection status polling stopped');
    }
    clearInterval(testConnectionInterval);
    testConnectionInterval = null;
  }
}

// Bắt đầu auto reconnect polling mỗi 30 phút
function startAutoReconnectPolling() {
  // Dừng polling cũ nếu có
  stopAutoReconnectPolling();

  if (extensionLogger) {
    extensionLogger.logInfo('Auto reconnect polling started', { interval: '30min' });
  }

  // Polling mỗi 30 phút
  autoReconnectInterval = setInterval(async () => {
    try {
      const { autoConnect } = await chrome.storage.local.get(['autoConnect']);

      // Chỉ auto reconnect nếu autoConnect được bật
      if (autoConnect !== false) {
        if (extensionLogger) {
          await extensionLogger.logInfo('Auto reconnect polling check', {
            socketExists: !!socket,
            socketConnected: socket?.connected || false,
            timestamp: new Date().toISOString()
          });
        }

        // Nếu socket không tồn tại hoặc không connected, thử kết nối lại
        if (!socket || !socket.connected) {
          if (extensionLogger) {
            await extensionLogger.logInfo('Auto reconnect triggered - socket disconnected', {
              socketExists: !!socket,
              socketConnected: socket?.connected || false
            });
          }

          await connectSocketIO(true); // Force reconnect
        } else {
          if (extensionLogger) {
            await extensionLogger.logInfo('Auto reconnect check - socket already connected', {
              socketId: socket.id
            });
          }
        }
      } else {
        if (extensionLogger) {
          await extensionLogger.logInfo('Auto reconnect skipped - autoConnect disabled');
        }
      }
    } catch (error) {
      if (extensionLogger) {
        await extensionLogger.logError(error, {
          context: 'auto_reconnect_polling'
        }, 'Auto reconnect polling error');
      }
    }
  }, 600000); // 30 phút = 1800000ms
}

// Dừng auto reconnect polling
function stopAutoReconnectPolling() {
  if (autoReconnectInterval) {
    if (extensionLogger) {
      extensionLogger.logInfo('Auto reconnect polling stopped');
    }
    clearInterval(autoReconnectInterval);
    autoReconnectInterval = null;
  }
}

// Expose debug function globally
globalThis.runExtensionDiagnostics = runExtensionDiagnostics;
globalThis.testConnection = testConnection;
globalThis.startTestConnectionPolling = startTestConnectionPolling;
globalThis.stopTestConnectionPolling = stopTestConnectionPolling;
globalThis.startAutoReconnectPolling = startAutoReconnectPolling;
globalThis.stopAutoReconnectPolling = stopAutoReconnectPolling;
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PING") return sendResponse({ ok: true });

      if (msg.type === "RELOAD_AUTO_CONFIG") {
        await startAutoConfigScheduler();
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

      if (msg.type === "RUN_ADS_SPEND")
        return sendResponse(await runExportAdsSpend(msg.payload?.date));

      // Manual full flow (CLICK) — emit log qua socket
      if (msg.type === "AUTO_RUN_NOW")
        return sendResponse(await runFullFlowAndEmitLogs("click"));

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

      if (msg?.type === "ADS_CHECK_NAMES") {
        const date = todayYMD();
        return sendResponse(await checkCampaign(date));
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

          return sendResponse({ ok: true, cookies });
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
            csrfToken: csrfToken,
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

        debugLog(`🧪 [TEST] Testing upload with manual CSRF token: ${csrfToken.slice(0, 20)}...`, 'info');

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
              csrfToken: csrfToken, // Use manual token
              carrierCode: 'USPS',
              shipMethod: 'USPS First Class',
              shipDate: '2026-04-06T00:22:22+00:00'
            }
          }
        };

        // Trigger upload with manual token
        const { type, payload } = testTask;
        const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();

        if (payload) {
          const { file, uploadParams } = payload;

          const blob = new Blob([file.content], { type: file.contentType });
          const fileObj = new File([blob], file.filename);

          uploadToAmazon(fileObj, uploadParams).then(() => {
            debugLog(`✅ Manual CSRF test successful!`, 'success');
            sendResponse({ ok: true, message: "Manual CSRF test successful" });
          }).catch(error => {
            debugLog(`❌ Manual CSRF test failed: ${error.message}`, 'error');
            sendResponse({ ok: false, error: error.message });
          });
        }

        return true; // Keep message channel open
      }

      if (msg?.type === "TEST_CONNECTION") {
        // Test connection thủ công
        const result = await testConnection();
        return sendResponse(result);
      }

      if (msg?.type === "START_TEST_POLLING") {
        // Bắt đầu polling thủ công
        startTestConnectionPolling();
        return sendResponse({ ok: true, message: "Test connection polling started" });
      }

      if (msg?.type === "STOP_TEST_POLLING") {
        // Dừng polling thủ công
        stopTestConnectionPolling();
        return sendResponse({ ok: true, message: "Test connection polling stopped" });
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

        // Trigger the same handler as socket task
        const { type, payload } = testTask;
        const { base, shopId, clientId, clientLabel } = await getBaseShopAndIdentity();

        if (payload?.autoGenerated) {
          debugLog(`🎯 Received test UPLOAD_TRACKING task: ${payload.reason}`, 'info');

          // Log task start
          await postLogSingle({
            base,
            token: (await getCfg()).ingestToken,
            shopId,
            machineId: clientId,
            label: clientLabel,
            action: "test",
            level: "info",
            message: `🎯 Starting TEST UPLOAD_TRACKING task: ${payload.reason}`
          });

          const { file, uploadParams, trackingData } = payload;

          // 1. File TXT đã sẵn sàng, không cần tạo
          const blob = new Blob([file.content], { type: file.contentType });
          const fileObj = new File([blob], file.filename);

          // Log file preparation
          await postLogSingle({
            base,
            token: (await getCfg()).ingestToken,
            shopId,
            machineId: clientId,
            label: clientLabel,
            action: "test",
            level: "info",
            message: `📄 Prepared test file: ${file.filename} (${file.content.length} bytes)`
          });

          // 2. Upload lên platform ngay lập tức
          uploadToAmazon(fileObj, uploadParams).then(() => {
            debugLog(`✅ Successfully uploaded test file ${file.filename}`, 'success');
            reportUploadResult(payload.batchId, 'success');
          }).catch(error => {
            debugLog(`❌ Failed to upload test file ${file.filename}: ${error.message}`, 'error');
            reportUploadResult(payload.batchId, 'failed', error.message);
          });
        }

        return sendResponse({ ok: true, message: "Test upload task triggered" });
      }

      sendResponse({ ok: false, message: "Unknown command" });
    } catch (e) {
      sendResponse({ ok: false, message: String(e?.message || e) });
    }
  })();
  return true;
});

// ── Khởi động tự động khi background script load ──
// Không phụ thuộc socket, chỉ cần có shopId và ingestUrl
(async () => {
  try {
    const { ingestUrl, shopId } = await getCfg();
    if (!ingestUrl || !shopId) {
      debugLog("⚙️ [INIT] Chưa có shopId/ingestUrl — bỏ qua auto start", "info");
      return;
    }
    debugLog("🚀 [INIT] Extension loaded — starting auto scheduler...", "info");
    await startAutoConfigScheduler();
    startAutoConfigSync();
    debugLog("✅ [INIT] Auto scheduler & sync started", "success");
  } catch (e) {
    debugLog(`❌ [INIT] Auto start error: ${e.message}`, "error");
  }
})();
