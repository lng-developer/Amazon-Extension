// options.js — APO LNG (Popup) - keep action keys & old log style

/* ========== Helpers ========== */
const $ = (s) => document.querySelector(s);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

// Log kiểu cũ: append xuống cuối, không dùng mảng/ghi đè
function log(...args) {
  const box = $("#log");
  if (!box) return;
  const line =
    `[${new Date().toLocaleTimeString()}] ` +
    args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  box.textContent += (box.textContent ? "\n" : "") + line;
}

function normalizeBaseUrl(u) {
  if (!u) return "";
  return u
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/ext\/ingest(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

function deriveApiUrls(base) {
  if (!base) return { importNewUrl: "", reportAllUrl: "", adsSpendUrl: "" };
  return {
    importNewUrl: `${base}/api/order/update-from-xlsx`,
    reportAllUrl: `${base}/api/report/import-file`,
    adsSpendUrl: `${base}/api/ads/import-day`,
  };
}

function setTodayDefault() {
  const d = $("#adsDate");
  if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
}

function previewEndpoints() {
  const raw = $("#ingestUrl")?.value || "";
  const base = normalizeBaseUrl(raw);

  const lines = base
    ? ["⏱ Auto anchors: 00:00 | 04:00 | 08:00 | 12:00 | 16:00 | 20:00"]
    : ["⚠️ Nhập API Base URL (ví dụ: https://api.lngmerch.co)"];

  const box = $("#log");
  if (box) box.textContent = lines.join("\n");
}

/* ========== Init ========== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const {
      ingestUrl = "",
      shopId = "",
      autoEnabled = false,
      adsHeaderLastSeen,
    } = await chrome.storage.local.get([
      "ingestUrl",
      "shopId",
      "autoEnabled",
      "adsHeaderLastSeen",
    ]);

    if ($("#ingestUrl")) $("#ingestUrl").value = ingestUrl;
    if ($("#shopId")) $("#shopId").value = shopId;

    // Toggle có thể là #autoToggle hoặc .switch input (theo HTML của bạn)
    const autoToggle =
      $("#autoToggle") || document.querySelector(".switch input");
    if (autoToggle) autoToggle.checked = !!autoEnabled;

    setTodayDefault();
    previewEndpoints();

    if (adsHeaderLastSeen) {
      log(
        `ℹ️ Ads headers last captured: ${new Date(
          adsHeaderLastSeen
        ).toLocaleString()}`
      );
    }

    // Ping để chắc chắn SW đang sống
    chrome.runtime.sendMessage({ type: "PING" }, (res) => {
      if (chrome.runtime.lastError) {
        log("SW unreachable:", chrome.runtime.lastError.message);
      } else {
        log("PING ->", res || {});
      }
    });
  } catch (e) {
    log("Init error:", e?.message || e);
  }
});

/* ========== Live preview Base URL ========== */
on($("#ingestUrl"), "input", previewEndpoints);

/* ========== Save config ========== */
on($("#saveBtn"), "click", async () => {
  try {
    let ingestUrl = normalizeBaseUrl($("#ingestUrl")?.value || "");
    const shopId = ($("#shopId")?.value || "").trim();

    if (!ingestUrl) return log("❌ Vui lòng nhập API Base URL hợp lệ.");
    if (!/^https?:\/\//i.test(ingestUrl))
      return log("❌ URL phải bắt đầu bằng http:// hoặc https://");

    await chrome.storage.local.set({ ingestUrl, shopId });
    log("Saved config", { ingestUrl, shopId });
    previewEndpoints();
  } catch (e) {
    log("Save error:", e?.message || e);
  }
});

/* ========== Auto enable/disable bằng toggle (nếu có) ========== */
const toggleEl = $("#autoToggle") || document.querySelector(".switch input");
on(toggleEl, "change", async (ev) => {
  const enabled = !!ev.target.checked;
  try {
    await chrome.storage.local.set({ autoEnabled: enabled });
    await chrome.runtime.sendMessage({
      type: enabled ? "AUTO_ENABLE" : "AUTO_DISABLE",
    });
    log(enabled ? "Auto ENABLE requested." : "Auto DISABLE requested.");
  } catch (e) {
    log("Auto toggle error:", e?.message || e);
  }
});

/* ========== Run now (gộp job) ========== */
on($("#btnAutoRunNow"), "click", async () => {
  $("#log").textContent = "Run job now...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "AUTO_RUN_NOW" });
    log(res);
  } catch (e) {
    log("❌ " + (e.message || e));
  }
});

/* ========== Export Ads theo ngày (nút riêng) ========== */
on($("#testAds"), "click", async () => {
  const date = $("#adsDate")?.value?.trim();
  if (!date) return log("❌ Vui lòng nhập ngày (YYYY-MM-DD)");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "RUN_ADS_SPEND",
      payload: { date },
    });
    if (res?.skipped && res?.reason === "ADS_TASK_ALREADY_RUNNING") {
      log("Ads task đang chạy, bỏ qua request mới để tránh 401.");
      return;
    }
    log("RUN_ADS_SPEND sent:", date);
  } catch (e) {
    if (e?.code === "ADS_TASK_ALREADY_RUNNING") {
      log("Ads task đang chạy, bỏ qua request mới để tránh 401.");
      return;
    }
    log("RUN_ADS_SPEND error:", e?.message || e);
  }
});

/* ========== (Tùy chọn) Connect backend nếu có nút #btnConnect ========== */
on($("#btnConnect"), "click", async () => {
  try {
    const base = normalizeBaseUrl($("#ingestUrl")?.value || "");
    if (base) await chrome.storage.local.set({ ingestUrl: base });
    log("Connecting to backend...");
    const r = await chrome.runtime.sendMessage({ type: "BACKEND_CONNECT" });
    if (r?.ok) log("✅ BACKEND_CONNECT →", r);
    else log("❌ BACKEND_CONNECT failed →", r || {});
  } catch (e) {
    log("❌ BACKEND_CONNECT error:", e?.message || e);
  }
});

/* ================================================================
   SOCKET.IO — Manual connect button in Options
   - Yêu cầu background đã hỗ trợ msg type: "MANUAL_SOCKET_CONNECT"
   - Nút HTML: <button id="btnSocketConnect">Connect Socket</button>
   ================================================================ */

on($("#btnSocketConnect"), "click", async () => {
  try {
    // Đồng bộ cấu hình mới nhất (nếu người dùng vừa sửa)
    const raw = $("#ingestUrl")?.value || "";
    const base = normalizeBaseUrl(raw);
    const shopId = ($("#shopId")?.value || "").trim();
    if (base) await chrome.storage.local.set({ ingestUrl: base });
    if (shopId) await chrome.storage.local.set({ shopId });

    log("🔌 Connecting Socket.IO to backend...");
    const res = await chrome.runtime.sendMessage({
      type: "SOCKET_CONNECT",
    });
    if (res?.ok) {
      log("✅ Socket connected manually.");
    } else {
      const msg = res?.message || "Unknown error";
      log("❌ Socket connect failed:", msg);
    }
  } catch (e) {
    log("❌ SOCKET_CONNECT error:", e?.message || e);
  }
});

/* ================================================================
   AUTO CLICK Connect Socket — chu kỳ cấu hình bằng input (phút)
   - Lưu vào chrome.storage.local key: socketAutoIntervalMin
   - 0 hoặc trống = tắt auto
   ================================================================ */
const DEFAULT_SOCKET_AUTO_INTERVAL_MIN = 60;
let _socketAutoTimer = null;

function applySocketAutoInterval(minutes) {
  if (_socketAutoTimer) {
    clearInterval(_socketAutoTimer);
    _socketAutoTimer = null;
  }
  const m = Number(minutes);
  if (!m || m <= 0 || !Number.isFinite(m)) {
    log("⏰ [Auto] Auto Connect Socket: TẮT");
    return;
  }
  const ms = m * 60 * 1000;
  _socketAutoTimer = setInterval(() => {
    const btn = $("#btnSocketConnect");
    if (!btn) return;
    log(`⏰ [Auto] Tự động click Connect Socket (mỗi ${m} phút)...`);
    btn.click();
  }, ms);
  log(`⏰ [Auto] Auto Connect Socket: BẬT — mỗi ${m} phút`);
}

(async () => {
  try {
    const { socketAutoIntervalMin } = await chrome.storage.local.get([
      "socketAutoIntervalMin",
    ]);
    const initial =
      socketAutoIntervalMin === undefined || socketAutoIntervalMin === null
        ? DEFAULT_SOCKET_AUTO_INTERVAL_MIN
        : Number(socketAutoIntervalMin);
    const inp = $("#socketAutoInterval");
    if (inp) inp.value = String(initial);
    applySocketAutoInterval(initial);
  } catch (e) {
    log("⏰ [Auto] Init error:", e?.message || e);
  }
})();

on($("#btnSaveSocketAutoInterval"), "click", async () => {
  try {
    const raw = $("#socketAutoInterval")?.value;
    const minutes =
      raw === "" || raw === null || raw === undefined ? 0 : Number(raw);
    if (Number.isNaN(minutes) || minutes < 0) {
      return log("❌ Vui lòng nhập số phút hợp lệ (>= 0).");
    }
    await chrome.storage.local.set({ socketAutoIntervalMin: minutes });
    log(`💾 Đã lưu Auto Connect Socket interval = ${minutes} phút`);
    applySocketAutoInterval(minutes);
  } catch (e) {
    log("❌ Save auto interval error:", e?.message || e);
  }
});

/* ========== Run Diagnostics ========== */
on($("#btnRunDiagnostics"), "click", async () => {
  // Clear log trước khi chạy diagnostics
  const logBox = $("#log");
  if (logBox) logBox.textContent = "";
  
  log("🔍 Running connection diagnostics...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_DIAGNOSTICS" });
    log("✅ Diagnostics started - results will appear below");
  } catch (e) {
    log("❌ Diagnostics error:", e.message || e);
  }
});

/* ========== Test Upload Tracking ========== */
on($("#btnTestUpload"), "click", async () => {
  // Clear log trước khi test
  const logBox = $("#log");
  if (logBox) logBox.textContent = "";
  
  log("🧪 Testing upload tracking to Amazon...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "TEST_UPLOAD_TRACKING" });
    log("✅ Test upload triggered - watch results below");
  } catch (e) {
    log("❌ Test upload error:", e.message || e);
  }
});

/* ========== Test CSRF Token Extraction ========== */
on($("#btnTestCSRF"), "click", async () => {
  // Clear log trước khi test
  const logBox = $("#log");
  if (logBox) logBox.textContent = "";
  
  log("🔑 Testing CSRF token extraction...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "TEST_CSRF_EXTRACTION" });
    if (res.ok && res.csrfToken) {
      log(`✅ CSRF Token found: ${res.csrfToken.slice(0, 30)}...`);
      log("🧪 You can now test upload with this token");
    } else {
      log("❌ No CSRF token found - check if you're logged into Amazon");
    }
  } catch (e) {
    log("❌ CSRF test error:", e.message || e);
  }
});

/* ========== Check Amazon Cookies ========== */
on($("#btnCheckCookies"), "click", async () => {
  log("🍪 Checking Amazon cookies...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "CHECK_AMAZON_COOKIES" });
    if (res.ok) {
      log("✅ Cookie check completed - see results above");
    } else {
      log("❌ Cookie check failed:", res.error);
    }
  } catch (e) {
    log("❌ Cookie check error:", e.message || e);
  }
});

/* ========== Open Amazon Seller Central ========== */
on($("#btnOpenAmazon"), "click", async () => {
  log("🌐 Opening Amazon Seller Central...");
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_AMAZON_SC" });
    if (res && res.ok) {
      log("✅ Amazon Seller Central opened - please login and test again");
    } else {
      log("❌ Auto-open failed. Please manually open:");
      log("   1. New tab → https://sellercentral.amazon.com");
      log("   2. Login with your Amazon Seller account");
      log("   3. Navigate to Order Reports");
      log("   4. Come back and test upload");
    }
  } catch (e) {
    log("❌ Auto-open failed. Please manually open:");
    log("   1. New tab → https://sellercentral.amazon.com");
    log("   2. Login with your Amazon Seller account");
    log("   3. Navigate to Order Reports");
    log("   4. Come back and test upload");
  }
});

/* ========== Auto Config Modal ========== */

const TYPE_LABEL = {
  IMPORT_ORDER:    "📦 Import Orders",
  IMPORT_FBM:      "🚚 Import FBM",
  IMPORT_ADS:      "📈 Import Ads",
  UPLOAD_TRACKING: "📤 Upload Tracking",
  PULL_TRACKING:   "🔄 Pull Tracking",
};

let _autoConfigTimer = null;

function renderAutoConfigList(records) {
  const list = $("#autoConfigList");
  if (!list) return;
  if (!records.length) {
    list.innerHTML = '<div style="color:#9ca3af;font-size:12px;text-align:center;padding:20px;">Khong co du lieu</div>';
    return;
  }
  list.innerHTML = records.map(r => {
    const statusColor = r.status ? "#16a34a" : "#dc2626";
    const statusText  = r.status ? "Bat" : "Tat";
    const label       = TYPE_LABEL[r.type] || r.type;
    const updatedAt   = new Date(r.updated_at).toLocaleString("vi-VN");
    return '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
      + '<span style="font-weight:700;font-size:12px;color:#374151;">' + label + '</span>'
      + '<span style="font-size:12px;font-weight:600;color:' + statusColor + ';">' + statusText + '</span>'
      + '</div>'
      + '<div style="font-size:11px;color:#6b7280;display:flex;flex-direction:column;gap:2px;">'
      + '<span>Shop: <b style="color:#111827;">' + r.shopName + '</b></span>'
      + '<span>Interval: <b style="color:#111827;">' + r.time + ' phut</b></span>'
      + '<span>' + r.describe + '</span>'
      + '<span>Cap nhat: ' + updatedAt + '</span>'
      + '</div></div>';
  }).join("");
}

async function loadAutoConfig() {
  try {
    const { ingestUrl = "", shopId = "" } = await chrome.storage.local.get(["ingestUrl", "shopId"]);
    if (!ingestUrl || !shopId) return log("Chua co API Base URL hoac Shop ID");

    const list = $("#autoConfigList");
    if (list) list.innerHTML = `<div style="color:#9ca3af;font-size:12px;text-align:center;padding:20px;">Dang tai...</div>`;

    const res = await fetch(`${ingestUrl}/api/auto-config?shopId=${shopId}`);
    const json = await res.json();
    if (!json.success) return log("API tra loi:", JSON.stringify(json));

    const records = (json.data || []).filter(r => r.shopId === shopId);
    renderAutoConfigList(records);
    log("✅ Auto config da duoc cap nhat");
  } catch (e) {
    log("Auto Config load error:", e?.message || e);
    const list = $("#autoConfigList");
    if (list) list.innerHTML = `<div style="color:#dc2626;font-size:12px;text-align:center;padding:20px;">Loi tai du lieu</div>`;
  }
}


on($("#btnAutoConfig"), "click", async () => {
  clearInterval(_autoConfigTimer);
  const overlay = $("#autoConfigOverlay");
  if (overlay) overlay.style.display = "flex";
  await loadAutoConfig();
  _autoConfigTimer = setInterval(async () => {
    log("🔄 [Auto Config] Auto refresh...");
    await loadAutoConfig();
  }, 5 * 60 * 1000);
});

on($("#reloadAutoConfig"), "click", () => loadAutoConfig());

on($("#closeAutoConfig"), "click", () => {
  const overlay = $("#autoConfigOverlay");
  if (overlay) overlay.style.display = "none";
  clearInterval(_autoConfigTimer);
  _autoConfigTimer = null;
});

/* ========== Nhận cập nhật từ background ========== */
chrome.runtime.onMessage.addListener((msg) => {
  // Đồng bộ trạng thái auto nếu background phát lại
  if (msg?.type === "AUTO_STATUS") {
    const t = $("#autoToggle") || document.querySelector(".switch input");
    if (t) t.checked = !!msg.enabled;
    log("AUTO_STATUS:", msg.enabled);
  }
  
  if (msg?.type === "LOG") {
    log(msg.payload);
  }
  
  // Nhận debug logs từ background
  if (msg?.type === "DEBUG_LOG") {
    const { message, level, timestamp } = msg.payload;
    
    // Tạo styled log message
    let styledMessage = `[${timestamp}] ${message}`;
    
    // Thêm vào log box với styling dựa trên level
    const logBox = $("#log");
    if (logBox) {
      const currentContent = logBox.textContent;
      logBox.textContent = currentContent + (currentContent ? "\n" : "") + styledMessage;
      
      // Auto scroll to bottom
      logBox.scrollTop = logBox.scrollHeight;
      
      // Add color styling based on level
      if (level === 'error') {
        // Highlight error messages
        const lines = logBox.textContent.split('\n');
        const lastLine = lines[lines.length - 1];
        if (lastLine.includes('❌') || lastLine.includes('Failed') || lastLine.includes('error')) {
          // Could add special styling here if needed
        }
      }
    }
  }
});

async function sendUploadFeedDebugCommand(type, label) {
  try {
    log(`${label}...`);
    const res = await chrome.runtime.sendMessage({ type });
    log(`${label} ->\n${JSON.stringify(res || {}, null, 2)}`);
  } catch (e) {
    log(`${label} error:`, e?.message || e);
  }
}

on($("#btnCheckUploadFeedReadiness"), "click", () => {
  sendUploadFeedDebugCommand("GET_UPLOADFEED_READINESS_STATUS", "Check uploadFeed readiness");
});

on($("#btnInstallUploadFeedSniffer"), "click", () => {
  sendUploadFeedDebugCommand("INSTALL_UPLOADFEED_CSRF_SNIFFER", "Install uploadFeed sniffer");
});

on($("#btnVerifyUploadFeedSniffer"), "click", () => {
  sendUploadFeedDebugCommand("VERIFY_UPLOADFEED_SNIFFER", "Verify uploadFeed sniffer");
});

on($("#btnCheckUploadFeedCache"), "click", () => {
  sendUploadFeedDebugCommand("CHECK_UPLOADFEED_CSRF_CACHE", "Check uploadFeed CSRF cache");
});

on($("#btnClearUploadFeedCache"), "click", () => {
  sendUploadFeedDebugCommand("CLEAR_UPLOADFEED_CSRF_CACHE", "Clear uploadFeed CSRF cache");
});

on($("#btnSocketResetBusy"), "click", () => {
  sendUploadFeedDebugCommand("SOCKET_RESET_BUSY", "Socket reset busy");
});

async function showFinalTsvFallback() {
  const res = await chrome.runtime.sendMessage({ type: "GET_LAST_UPLOAD_TRACKING_FINAL_TSV" });
  const box = $("#finalTsvFallbackBox");
  const text = $("#finalTsvFallbackText");
  if (box) box.style.display = "block";
  if (text) text.value = res?.content || "";
  log("Final TSV fallback ->\n" + JSON.stringify({
    ok: !!res?.ok,
    batchId: res?.batchId,
    filename: res?.filename,
    rows: res?.rows,
    tsvLength: res?.tsvLength,
    tsvChecksum: res?.tsvChecksum
  }, null, 2));
}

on($("#btnDownloadFinalTsv"), "click", async () => {
  try {
    log("Download final TSV...");
    const res = await chrome.runtime.sendMessage({ type: "DOWNLOAD_LAST_UPLOAD_TRACKING_FINAL_TSV" });
    log("Download final TSV ->\n" + JSON.stringify(res || {}, null, 2));
    if (res?.error === "downloads permission is not enabled for this extension") {
      await showFinalTsvFallback();
    }
  } catch (e) {
    log("Download final TSV error:", e?.message || e);
    await showFinalTsvFallback();
  }
});

on($("#btnCopyFinalTsv"), "click", async () => {
  const text = $("#finalTsvFallbackText")?.value || "";
  try {
    await navigator.clipboard.writeText(text);
    log("Final TSV copied.");
  } catch (e) {
    log("Copy final TSV failed:", e?.message || e);
  }
});
