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
  const MSG_TYPE_SNIFF = "APO_ADS_HEADER_SNIFF";

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

  // ---------- Build headers cho retrieveReport ----------
  async function buildAdsHeaders() {
    const {
      adsAccountId,
      adsAdvertiserId,
      adsClientId,
      adsMarketplaceId,
      adsCsrfData,
      adsCsrfToken,
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

    // Cảnh báo nhẹ nếu thiếu cặp CSRF
    if (!adsCsrfData || !adsCsrfToken) {
      console.warn(
        "[APO][ADS] Missing CSRF headers in storage → request có thể 401. Hãy tương tác Ads UI để auto-capture."
      );
    }
    return h;
  }

  // ---------- Gọi retrieveReport bằng headers hiện tại ----------
  async function callRetrieveReport(payload) {

    const cfg = await getCfg();
    console.log("[ADS][DEBUG][cfg]", JSON.stringify(cfg, null, 2));
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
    const safeHeadersForLog = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [
        k,
        /csrf|token|account|advertiser|client/i.test(k) && v ? `${String(v).slice(0, 6)}...` : v,
      ])
    );
    console.log("[APO][ADS] retrieveReport → headers(use)", safeHeadersForLog);
    bridgeLog("info", "[ADS_BRIDGE] retrieveReport headers built", {
      hasAccountId: !!headers["Amazon-Ads-Account-Id"],
      hasAdvertiserId: !!headers["Amazon-Advertising-Api-Advertiserid"],
      hasCsrfToken: !!headers["Amazon-Advertising-Api-Csrf-Token"],
      hasCsrfData: !!headers["Amazon-Advertising-Api-Csrf-Data"],
    });
    console.log("[APO][ADS] retrieveReport → payload", payload);

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
    console.log("[APO][ADS] retrieveReport ←", res.status, text.slice(0, 300));
    bridgeLog(
      res.ok ? "info" : "error",
      `[ADS_BRIDGE] retrieveReport response: ${res.status}`,
      { status: res.status, ok: res.ok, preview: text.slice(0, 300) }
    );
    return { status: res.status, ok: res.ok, text };
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
        setCfg({ ...data, adsHeaderLastSeen: Date.now() });
        bridgeLog("info", "[ADS_BRIDGE] Headers captured and saved to storage", { keys: Object.keys(data) });
      } catch (e) {
        bridgeLog("error", "[ADS_SNIFFER] send error: " + e.message);
      }
    }

    // Page-context sniffer được inject từ background bằng chrome.scripting.executeScript({ world: "MAIN" }).
    // File này chỉ nhận window.postMessage và lưu headers vào chrome.storage.local.
    bridgeLog("info", "[ADS_SNIFFER] content bridge initialized", { url: location.href });
  }

  // ---------- Nhận headers từ page → lưu storage ----------
  let lastWrite = 0;
  window.addEventListener("message", async (evt) => {
    const msg = evt && evt.data;
    if (!msg || !msg.__apo) return;
    if (msg.type !== MSG_TYPE_SNIFF) return;
    const data = msg.data || {};
    try {
      // debounce nhỏ để tránh spam storage
      const now = Date.now();
      if (now - lastWrite < 300) return;
      lastWrite = now;

      const toSave = { ...data, adsHeaderLastSeen: now };
      await setCfg(toSave);
      console.log("[APO][ADS] captured headers -> storage", toSave);
      bridgeLog("info", "[ADS_BRIDGE] Headers captured and saved to storage", { keys: Object.keys(toSave) });
    } catch (e) {
      console.warn("[APO][ADS] save headers error:", e);
    }
  });

  injectSniffer();
  bridgeLog("info", "[ADS_BRIDGE] injectSniffer called", { url: location.href });

  // ---------- Bridge từ background ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type !== "ADS_FETCH_REPORT") return;
      try {
        const r = await callRetrieveReport(msg.payload);
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
