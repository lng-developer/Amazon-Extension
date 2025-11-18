/* ===============================
   background.js (MV3, ESM) — APO LNG (Realtime only)
   - Không ghi DB: không /api/ext/connect, không /api/logs/*
   - Chỉ Socket.IO realtime: ext:heartbeat, ext:log, client:ack
   - Import NEW / Report ALL / Ads vẫn hoạt động như cũ
   - Auto: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 (giờ LOCAL)
   =============================== */

import { io } from "./lib/socket.io.esm.min.js";

const log = (...args) => console.log("[APO]", ...args);

const SC_BASE = "https://sellercentral.amazon.com";
const ADS_BASE = "https://advertising.amazon.com";
const ADS_RETRIEVE_URL =
  "https://advertising.amazon.com/a9g-api-gateway/cm/dds/retrieveReport";

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
  const xcsrf = await getCookie(`${SC_BASE}/`, "x-amz-csrf");
  const h = {
    accept: "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
    referer: `${SC_BASE}/order-reports-and-feeds/reports`,
  };
  if (a2z) h["anti-csrftoken-a2z"] = a2z;
  if (xcsrf) h["x-amz-csrf-token"] = xcsrf;
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
    reportAllUrl: `${base}/api/report/import-file`,
    adsSpendUrl: `${base}/api/ads/import-day`,
    importOrderUrl: `${base}/api/ext/import-order`,
    importReportUrl: `${base}/api/ext/import-report`,
    importAdsUrl: `${base}/api/ext/import-ads`,
    getSeller: `${base}/api/user/employee-code`,
  };
}

/* ---------- Identity ---------- */
async function ensureIdentity() {
  let { clientId, clientLabel } = await chrome.storage.local.get([
    "clientId",
    "clientLabel",
  ]);
  if (!clientId) {
    clientId =
      "cid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await chrome.storage.local.set({ clientId });
  }
  clientLabel = "Machine-" + clientId.slice(-4);
  await chrome.storage.local.set({ clientLabel });
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
function buildAllOrdersPayload(startDur = "P1D", endDur = "P0D") {
  return {
    type: "allOrdersReport",
    reportVersion: "orderDateVersion",
    includeSalesChannel: null,
    startDate: startDur,
    endDate: endDur,
  };
}
async function requestReferenceIdNew(body) {
  const url = `${SC_BASE}/order-reports-and-feeds/api/reportRequest`;
  const res = await requestOnce(url, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `reportRequest NEW ${res.status} — ${(
        await res.text().catch(() => "")
      ).slice(0, 200)}`
    );
  if (!isJson(res)) throw new Error(`reportRequest NEW non-JSON`);
  const j = await res.json();
  return j?.referenceId || j?.data?.referenceId;
}
async function requestReferenceIdAll(body) {
  const url = `${SC_BASE}/order-reports-and-feeds/api/v1/reportRequest`;
  const res = await requestOnce(url, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `reportRequest ALL ${res.status} — ${(
        await res.text().catch(() => "")
      ).slice(0, 200)}`
    );
  if (!isJson(res)) throw new Error(`reportRequest ALL non-JSON`);
  const j = await res.json();
  return j?.referenceId || j?.data?.referenceId;
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
  const dlUrl = `${SC_BASE}/order-reports-and-feeds/feeds/download?documentId=${encodeURIComponent(
    documentId
  )}&fileType=txt`;
  const r = await requestOnce(dlUrl, { method: "GET" });
  if (!r.ok) throw new Error(`Amazon download ${r.status}`);
  const tsv = await r.text();
  const { rows } = parseTSV(tsv);
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
  if (activeRefs.has(referenceId)) return activeRefs.get(referenceId);
  const job = (async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const st = await checkReportReady(referenceId);
      if (st.ready) {
        activeRefs.delete(referenceId);
        if (st.direct) return { direct: true, tsv: st.tsv };
        return { documentId: st.documentId };
      }
      if (attempt < maxAttempts) await sleep(intervalMs);
    }
    activeRefs.delete(referenceId);
    throw new Error(
      `Report ${referenceId} chưa sẵn sàng sau ${
        (intervalMs * maxAttempts) / 1000
      }s`
    );
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

async function runReportAllOrders(referenceOverride) {
  const { ingestUrl, shopId, refAllOrders } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { reportAllUrl } = deriveApiUrls(ingestUrl);

  let referenceId = referenceOverride;
  if (!referenceId) {
    try {
      referenceId = await requestReferenceIdAll(
        buildAllOrdersPayload("P1D", "P0D")
      );
    } catch (e) {
      referenceId = refAllOrders;
    }
  }
  if (!referenceId) throw new Error("No referenceId found for ALL orders");

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

  const ingest = await postFileTo(reportAllUrl, {
    shopId,
    file: { name: `orders-all-${referenceId}.txt`, text: tsv },
  });

  return { ok: true, rows, documentId, referenceId, ingest };
}

/* ===============================
   ADS via content-script
   =============================== */
async function ensureAdsTab() {
  let tabs = await chrome.tabs.query({ url: `${ADS_BASE}/*` });
  let tab;
  if (tabs.length) tab = tabs[0];
  else {
    tab = await chrome.tabs.create({
      url: `${ADS_BASE}/cm/campaigns`,
      active: false,
    });
  }
  if (tab.status !== "complete") {
    await new Promise((resolve) => {
      const onUpdated = (tid, info) => {
        if (tid === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }
  return tab.id;
}

async function adsRetrieveViaContentScript(payload) {
  const tabId = await ensureAdsTab();
  const sendOnce = () =>
    chrome.tabs.sendMessage(tabId, {
      type: "ADS_FETCH_REPORT",
      url: ADS_RETRIEVE_URL,
      payload,
    });

  try {
    const r = await sendOnce();
    if (r) return r;
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ads_bridge.js"],
    });
    await new Promise((r) => setTimeout(r, 300));
  } catch (_) {}

  for (let i = 0; i < 2; i++) {
    try {
      const r = await sendOnce();
      if (r) return r;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error("Could not establish connection to ads_bridge.js");
}

async function fetchAdsJsonCS(payload) {
  const r = await adsRetrieveViaContentScript(payload);
  if (!r) throw new Error("retrieveReport no response");
  if (!r.ok) {
    const sample =
      typeof r.text === "string" ? r.text : JSON.stringify(r.text || "");
    throw new Error(`retrieveReport ${r.status} — ${sample.slice(0, 200)}`);
  }
  let j;
  try {
    j = JSON.parse(r.text || "{}");
  } catch {
    const sample =
      typeof r.text === "string" ? r.text : JSON.stringify(r.text || "");
    throw new Error(`retrieveReport non-JSON: ${sample.slice(0, 200)}`);
  }
  return j;
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
  if (count === 0 || rows1.length === 0) return [];

  const totalPages = Math.ceil(count / pageSize);
  let all = rows1;

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
    if (!more.length) break;
    all = all.concat(more);
  }

  return all.map((r) => ({
    campaignName: r.campaignName ?? "",
    date: startDate,
    spend: Number(r.spend ?? 0),
    state: r.state ?? "",
  }));
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
  const { ingestUrl, shopId } = await getCfg();
  if (!ingestUrl) throw new Error("Missing ingestUrl (Options)");
  const { adsSpendUrl } = deriveApiUrls(ingestUrl);
  if (!date) throw new Error("date (YYYY-MM-DD) required");

  const rows = await fetchAllCampaignSpend(date, date, 300);
  const txt = campaignRowsToTxt(rows);

  const ingestRes = await postFileTo(adsSpendUrl, {
    shopId,
    day: date,
    file: { name: `ads-spend-${date}.txt`, text: txt },
  });

  return { ok: true, rows: rows.length, ingest: ingestRes };
}

/* ===============================
   AUTO SCHEDULER — 0h/4h/8h/12h/16h/20h (LOCAL)
   =============================== */
const AUTO_ALARM = "apo-auto-fixed";
let autoBusy = false;

function nextAlignedTs(fromTs = Date.now(), baseHour = 0, everyHours = 4) {
  const d = new Date(fromTs);
  d.setMinutes(0, 0, 0);
  let h = d.getHours();
  const mod = (((h - baseHour) % everyHours) + everyHours) % everyHours;
  if (mod !== 0 || fromTs > d.getTime()) {
    h = h + (everyHours - mod);
    d.setHours(h, 0, 0, 0);
  }
  if (d.getTime() <= fromTs) d.setHours(d.getHours() + everyHours, 0, 0, 0);
  return d.getTime();
}

async function scheduleNextAnchor() {
  await chrome.alarms.clear(AUTO_ALARM);
  const when = nextAlignedTs(Date.now(), 0, 4);
  chrome.alarms.create(AUTO_ALARM, { when });
  log("[AUTO] next tick at", new Date(when).toLocaleString());
}

async function scheduleAutoRun(enable = true) {
  await chrome.alarms.clear(AUTO_ALARM);
  await chrome.storage.local.set({ autoEnabled: enable });

  if (!enable) {
    log("[AUTO] disabled");
    return { ok: true, enabled: false };
  }
  await scheduleNextAnchor();
  return {
    ok: true,
    enabled: true,
    schedule: "00:00 | 04:00 | 08:00 | 12:00 | 16:00 | 20:00",
  };
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
  } catch (_) {}
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

  try {
    try {
      await runImportNewOrders(undefined);
      phases.push({ type: "import", status: "success" });
    } catch (error) {
      phases.push({ type: "import", status: "fail" });
    }
    try {
      await runReportAllOrders(undefined);
      phases.push({ type: "report", status: "success" });
    } catch (error) {
      phases.push({ type: "report", status: "fail" });
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

async function runAutoJob() {
  if (autoBusy) {
    console.log("[AUTO] skip, job is running");
    return { ok: false, message: "busy" };
  }
  autoBusy = true;
  try {
    return await runFullFlowAndEmitLogs("auto");
  } finally {
    autoBusy = false;
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_ALARM) {
    await runAutoJob();
    await scheduleNextAnchor();
  }
});

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

async function saveAdsHeadersIfAny(found) {
  const keys = Object.keys(found);
  if (!keys.length) return;

  const current = await chrome.storage.local.get(keys);
  let changed = false;
  for (const k of keys) {
    if (found[k] && found[k] !== current[k]) {
      changed = true;
      break;
    }
  }
  if (changed) {
    await chrome.storage.local.set({
      ...found,
      adsHeaderLastSeen: Date.now(),
    });
    log("[ADS] headers updated:", Object.keys(found).join(", "));
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      if (!details?.url?.startsWith(ADS_BASE)) return;
      const found = collectAdsHeaders(details.requestHeaders || []);
      saveAdsHeadersIfAny(found);
    } catch {}
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
export async function connectSocketIO(force = false) {
  if (connectBusy) return { ok: false, reason: "busy" };
  connectBusy = true;
  try {
    const { base, shopId, clientId, clientLabel } =
      await getBaseShopAndIdentity();
    if (!base) {
      console.log("[SOCKET] Missing base");
      return { ok: false, reason: "base missing" };
    }
    if (!shopId) {
      console.log("[SOCKET] Missing shopId");
      return { ok: false, reason: "shopId missing" };
    }

    // Khi không force và đang connected thì thôi
    if (!force && socket && socket.connected) {
      return { ok: true, message: "already connected" };
    }

    // Nếu có socket cũ, disconnect trước
    if (socket) {
      try {
        socket.disconnect();
      } catch {}
      socket = null;
    }

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

    socket.on("connect", async () => {
      console.log("[SOCKET] connected", socket.id);
      await postLogSingle({
        base,
        shopId,
        machineId: clientId,
        label: clientLabel,
        action: "auto",
        level: "success",
        message: `✅ Extension connected to Socket.IO`,
      });
      startHeartbeat();
    });

    socket.on("disconnect", async (reason) => {
      console.log("[SOCKET] disconnected:", reason);
      await postLogSingle({
        base,
        shopId,
        machineId: clientId,
        label: clientLabel,
        action: "auto",
        level: "error",
        message: `❌ Extension disconnected to Socket.IO`,
      });
      stopHeartbeat();
      // để reconnection tự xử lý (đã bật trong options ở trên)
    });

    // (tuỳ chọn) nhận task từ server nếu bạn vẫn muốn bắn lệnh IMPORT_ORDERS
    socket.on("server:task", async (task) => {
      const { type, payload } = task || {};
      try {
        switch (type) {
          case "PULL_ALL":
            runFullFlowAndEmitLogs("click");
            break;
          case "IMPORT_ORDERS":
            runFullFlowAndEmitLogs("click");
            break;
          case "IMPORT_ADS_SPEND":
            const day = payload?.date;
            if (!day) throw new Error("Missing payload.date");
            try {
              await runExportAdsSpend(day);
              await postLogSingle({
                base,
                shopId,
                machineId: clientId,
                label: clientLabel,
                action: "click",
                level: "success",
                message: "✅ Import ads success!",
              });
            } catch (error) {
              await postLogSingle({
                base,
                shopId,
                machineId: clientId,
                label: clientLabel,
                action: "click",
                level: "error",
                message: "❌ Import ads error!",
              });
            }
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("[SOCKET] task error:", e?.message || e);
      }
    });

    return { ok: true };
  } finally {
    connectBusy = false;
  }
}

// ====== Tự động connect khi extension khởi động (nếu autoConnect=true) ======
chrome.runtime.onInstalled.addListener(async () => {
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
  const st = await chrome.storage.local.get(["autoConnect"]);
  if (st.autoConnect !== false) {
    connectSocketIO(true); // force trên mỗi lần khởi động
  }
});

// ====== Tự reconnect khi đổi ingestUrl/shopId trong Options ======
chrome.storage.onChanged.addListener((changes) => {
  if (changes.ingestUrl || changes.shopId) {
    setTimeout(() => connectSocketIO(true), 300);
  }
});

/* ===============================
   Bridge cho Options / DevTools
   =============================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "PING") return sendResponse({ ok: true });

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

      // Auto on/off
      if (msg.type === "AUTO_ENABLE")
        return sendResponse(await scheduleAutoRun(true));
      if (msg.type === "AUTO_DISABLE")
        return sendResponse(await scheduleAutoRun(false));
      if (msg.type === "AUTO_SET")
        return sendResponse(await scheduleAutoRun(!!msg.enabled));

      sendResponse({ ok: false, message: "Unknown command" });
    } catch (e) {
      sendResponse({ ok: false, message: String(e?.message || e) });
    }
  })();
  return true;
});

/* ---------- Lifecycle ---------- */
chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(["autoEnabled"]);
  await ensureIdentity();
  await scheduleAutoRun(st.autoEnabled ?? true);
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await chrome.storage.local.get(["autoEnabled"]);
  await ensureIdentity();
  if (st.autoEnabled ?? true) await scheduleNextAnchor();
  else await chrome.alarms.clear(AUTO_ALARM);
});
