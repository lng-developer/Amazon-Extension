// ads_bridge.js
// Chạy trong content-script của advertising.amazon.com
// - Nghe background để gọi retrieveReport bằng headers từ Storage
// - TỰ ĐỘNG chụp headers Amazon Ads bằng cách inject script patch fetch/XHR trong page context
//   rồi postMessage về content-script -> lưu chrome.storage.local

(() => {
  if (window.__APO_ADS_BRIDGE_READY__) {
    console.debug("[APO][ADS] ads_bridge.js already initialized");
    return;
  }
  window.__APO_ADS_BRIDGE_READY__ = true;

  const ADS_HOST = "advertising.amazon.com";
  const ADS_BASE = `https://${ADS_HOST}`;
  const RETRIEVE_URL = `${ADS_BASE}/a9g-api-gateway/cm/dds/retrieveReport`;
  const REPORTING_URLS = {
    QUERY_CONFIGURATIONS: `${ADS_BASE}/a9g-api-gateway/adsApi/v1/query/reportConfigurations`,
    CREATE_CONFIGURATION: `${ADS_BASE}/a9g-api-gateway/adsApi/v1/create/reportConfigurations`,
    RUN_CONFIGURATION: `${ADS_BASE}/a9g-api-gateway/adsApi/v1/create/scheduledReports`,
  };
  const MSG_TYPE_SNIFF = "APO_ADS_HEADER_SNIFF";
  const MSG_TYPE_DOWNLOAD = "APO_ADS_DOWNLOAD_URL";

  if (!location.host.endsWith(ADS_HOST)) {
    console.warn("[APO][ADS] Wrong host for ads_bridge.js:", location.href);
  }

  // ---------- Logger bridge → background extensionLogger ----------
  function bridgeLog(level, message, rawData = {}) {
    try {
      chrome.runtime.sendMessage({
        type: "ADS_BRIDGE_LOG",
        payload: { level, message, rawData, timestamp: new Date().toISOString() }
      }).catch(() => { });
    } catch (_) { }
  }

  // ---------- Storage helpers ----------
  function getCfg(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        keys || [
          "adsAccountId",
          "adsAdvertiserId",
          "adsClientId",
          "adsMarketplaceId",
          "adsCsrfData",
          "adsCsrfToken",
          "adsReportingCsrfToken",
          "adsHeaderLastSeen",
          "adsApiLockState",
          "adsCandidateHeaders",
        ],
        (st) => resolve(st || {})
      );
    });
  }
  function setCfg(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  function isAdsApiLockedState(lockState) {
    if (!lockState?.running) return false;
    const age = Date.now() - Number(lockState.startedAt || 0);
    return age < 5 * 60 * 1000;
  }

  async function saveCapturedAdsHeaders(data, source = "ads_bridge") {
    const clean = Object.fromEntries(
      Object.entries(data || {}).filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    );
    if (!Object.keys(clean).length) return false;

    const now = Date.now();
    const { adsApiLockState } = await getCfg(["adsApiLockState"]);
    if (isAdsApiLockedState(adsApiLockState)) {
      await setCfg({
        adsCandidateHeaders: {
          ...clean,
          adsHeaderLastSeen: now,
          source,
          capturedAt: now,
        },
      });
      bridgeLog("info", "[ADS_BRIDGE] Captured headers stored as candidate because Ads API is locked", {
        keys: Object.keys(clean),
        runningTaskName: adsApiLockState.taskName,
        runningRunId: adsApiLockState.runId,
      });
      return false;
    }

    const toSave = { ...clean, adsHeaderLastSeen: now };
    await setCfg(toSave);
    bridgeLog("info", "[ADS_BRIDGE] Headers captured and saved to storage", { keys: Object.keys(toSave) });
    return true;
  }

  // ---------- Build headers cho retrieveReport ----------
  async function buildAdsHeaders() {
    const {
      adsAccountId,
      adsAdvertiserId,
      adsClientId,
      adsMarketplaceId,
      adsCsrfData,
      adsCsrfToken,
      adsReportingCsrfToken,
    } = await getCfg();

    const h = {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json;charset=UTF-8",
      "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5",
      Advertisertype: "SELLER",
    };

    if (adsAccountId) h["Amazon-Ads-Account-Id"] = adsAccountId;
    if (adsAdvertiserId)
      h["Amazon-Advertising-Api-Advertiserid"] = adsAdvertiserId;
    if (adsClientId) h["Amazon-Advertising-Api-Clientid"] = adsClientId;
    if (adsMarketplaceId)
      h["Amazon-Advertising-Api-Marketplaceid"] = adsMarketplaceId;

    // CSRF bắt buộc
    if (adsCsrfData) h["Amazon-Advertising-Api-Csrf-Data"] = adsCsrfData;
    if (adsCsrfToken) h["Amazon-Advertising-Api-Csrf-Token"] = adsCsrfToken;
    if (adsReportingCsrfToken) h["x-csrf-token"] = adsReportingCsrfToken;

    // Cảnh báo nhẹ nếu thiếu cặp CSRF
    if (!adsCsrfData || !adsCsrfToken) {
      console.warn(
        "[APO][ADS] Missing CSRF headers in storage → request có thể 401. Hãy tương tác Ads UI để auto-capture."
      );
    }
    return h;
  }

  // ---------- Gọi retrieveReport bằng headers hiện tại ----------
  async function callRetrieveReport(payload, options = {}) {
    const reportConfig = payload?.reportConfig || {};
    const pagination = reportConfig?.offsetPagination || {};

    const cfg = await getCfg();
    bridgeLog("info", "[ADS_BRIDGE] Storage config loaded", {
      hasAccountId: !!cfg.adsAccountId,
      hasAdvertiserId: !!cfg.adsAdvertiserId,
      hasClientId: !!cfg.adsClientId,
      hasMarketplaceId: !!cfg.adsMarketplaceId,
      hasCsrfToken: !!cfg.adsCsrfToken,
      hasCsrfData: !!cfg.adsCsrfData,
      lastSeen: cfg.adsHeaderLastSeen ? new Date(cfg.adsHeaderLastSeen).toLocaleString() : "never",
    });

    const headers = await buildAdsHeaders();
    bridgeLog("info", "[ADS_BRIDGE] retrieveReport headers built", {
      hasAccountId: !!headers["Amazon-Ads-Account-Id"],
      hasAdvertiserId: !!headers["Amazon-Advertising-Api-Advertiserid"],
      hasCsrfToken: !!headers["Amazon-Advertising-Api-Csrf-Token"],
      hasCsrfData: !!headers["Amazon-Advertising-Api-Csrf-Data"],
    });
    const res = await fetch(RETRIEVE_URL, {
      method: "POST",
      credentials: "include",
      mode: "cors",
      headers,
      referrer: `${ADS_BASE}/cm/campaigns`,
      referrerPolicy: "strict-origin-when-cross-origin",
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    bridgeLog(
      res.ok ? "info" : "error",
      `[ADS_BRIDGE] retrieveReport response: ${res.status} offset=${pagination.offset}`,
      {
        status: res.status,
        ok: res.ok,
        startDate: reportConfig.startDate,
        endDate: reportConfig.endDate,
        offset: pagination.offset,
        size: pagination.size,
        runId: options.runId,
        lockOwner: !!options.lockOwner,
        attempt: options.attempt,
      }
    );
    return { status: res.status, ok: res.ok, text };
  }

  async function callReportingApi(operation, payload) {
    const url = REPORTING_URLS[operation];
    if (!url) throw new Error(`Unsupported Amazon Ads reporting operation: ${operation}`);
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: await buildAdsHeaders(),
      referrer: `${ADS_BASE}/reporting`,
      referrerPolicy: 'strict-origin-when-cross-origin',
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { }
    if (!res.ok) throw new Error(`Amazon Ads reporting ${operation} failed (${res.status}).`);
    return { status: res.status, data };
  }

  function isVisible(element) {
    const rect = element?.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function findDownloadControl() {
    return [...document.querySelectorAll('a,button,[role="menuitem"]')]
      .find((element) => isVisible(element) && /download latest/i.test(element.textContent || element.getAttribute('aria-label') || ''));
  }

  async function revealDownloadControl() {
    const direct = findDownloadControl();
    if (direct) return direct;
    const menuButtons = [...document.querySelectorAll('button,[role="button"]')]
      .filter((element) => isVisible(element) && /more|action|option/i.test([
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
      ].filter(Boolean).join(' ')));
    for (const button of menuButtons) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const control = findDownloadControl();
      if (control) return control;
    }
    return null;
  }

  async function requestLatestDownload() {
    const direct = await revealDownloadControl();
    if (!direct) throw new Error('Amazon Ads Download latest is unavailable. Keep the Amazon Reporting tab open and try again.');
    const href = direct.href || '';
    if (/amazonaws\.com/i.test(href)) return href;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Amazon Ads did not provide a CSV download link.'));
      }, 15_000);
      const onMessage = (event) => {
        const message = event?.data;
        if (event.origin !== location.origin || message?.type !== MSG_TYPE_DOWNLOAD || !message.url) return;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(message.url);
      };
      window.addEventListener('message', onMessage);
      direct.click();
    });
  }

  // ---------- Inject page script để bắt headers từ request gốc ----------
  // Chạy trực tiếp trong content-script (ISOLATED world) — không dùng <script> tag vì CSP block
  function injectSniffer() {
    const TARGET_HOST = ADS_HOST;

    function pickHeaders(h) {
      const out = {};
      if (!h) return out;
      try {
        if (typeof h.forEach === "function") {
          h.forEach((v, k) => (out[String(k)] = String(v)));
        } else {
          for (const k in h) out[String(k)] = String(h[k]);
        }
      } catch {}
      return out;
    }

    function extractAdsHeaders(headersObj) {
      const src = {};
      for (const [k, v] of Object.entries(headersObj || {})) src[k.toLowerCase()] = v;
      const M = {
        "amazon-ads-account-id": "adsAccountId",
        "amazon-advertising-api-advertiserid": "adsAdvertiserId",
        "amazon-advertising-api-clientid": "adsClientId",
        "amazon-advertising-api-marketplaceid": "adsMarketplaceId",
        "amazon-advertising-api-csrf-data": "adsCsrfData",
        "amazon-advertising-api-csrf-token": "adsCsrfToken",
      };
      const out = {};
      for (const [lk, key] of Object.entries(M)) if (src[lk]) out[key] = src[lk];
      return out;
    }

    function shouldCapture(url) {
      try { return new URL(url, location.href).host.endsWith(TARGET_HOST); }
      catch { return false; }
    }

    function send(headersObj) {
      try {
        const data = extractAdsHeaders(headersObj);
        bridgeLog("info", "[ADS_SNIFFER] Headers extracted", { keys: Object.keys(data) });
        if (!Object.keys(data).length) return;
        // Lưu thẳng vào storage từ content-script (không cần postMessage)
        saveCapturedAdsHeaders(data, "ads_bridge_direct").catch((e) => {
          bridgeLog("error", "[ADS_SNIFFER] save candidate error: " + e.message);
        });
      } catch (e) {
        bridgeLog("error", "[ADS_SNIFFER] send error: " + e.message);
      }
    }

    // Page-context sniffer được inject từ background bằng chrome.scripting.executeScript({ world: "MAIN" }).
    // File này chỉ nhận window.postMessage và lưu headers vào chrome.storage.local.
    bridgeLog("info", "[ADS_SNIFFER] content bridge initialized", { url: location.href });
  }

  // ---------- Nhận headers từ page → lưu storage ----------
  window.addEventListener("message", async (evt) => {
    const msg = evt && evt.data;
    if (!msg || !msg.__apo) return;
    if (msg.type !== MSG_TYPE_SNIFF) return;
    const data = msg.data || {};
    try {
      await saveCapturedAdsHeaders(data, "ads_bridge");
    } catch (e) {
      console.warn("[APO][ADS] save headers error:", e);
    }
  });

  injectSniffer();
  bridgeLog("info", "[ADS_BRIDGE] injectSniffer called", { url: location.href });

  // ---------- Bridge từ background ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'ADS_REPORTING_REQUEST') {
        try {
          const result = await callReportingApi(msg.operation, msg.payload);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, status: 0, message: error?.message || String(error) });
        }
        return;
      }
      if (msg?.type === 'ADS_DOWNLOAD_LATEST_REPORT') {
        try {
          const downloadUrl = await requestLatestDownload();
          sendResponse({ ok: true, downloadUrl });
        } catch (error) {
          sendResponse({ ok: false, status: 0, message: error?.message || String(error) });
        }
        return;
      }
      if (msg?.type !== "ADS_FETCH_REPORT") return;
      try {
        const r = await callRetrieveReport(msg.payload, msg.options || {});
        sendResponse(r);
      } catch (e) {
        console.error("[APO][ADS] retrieveReport error:", e);
        sendResponse({
          ok: false,
          status: 0,
          text: String(e && e.message ? e.message : e),
        });
      }
    })();
    return true; // async
  });

  console.log("[APO][ADS] ads_bridge.js ready on", location.href);
  bridgeLog("info", "[ADS_BRIDGE] ads_bridge.js ready", { url: location.href });
})();
