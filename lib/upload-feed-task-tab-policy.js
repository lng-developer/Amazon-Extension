export function shouldCloseDedicatedUploadFeedTab({ created, uploaded }) {
  return created === true && uploaded === true;
}

export function canSubmitAmazonRow({ tracking, carrier, shipDate }) {
  return Boolean(
    String(tracking || "").trim() &&
      String(carrier || "").trim() &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(shipDate || "").trim()),
  );
}

export const AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE = "America/Los_Angeles";

export function formatDateYmdInTimeZone(date = new Date(), timeZone = AMAZON_CONFIRM_SHIPMENT_MARKETPLACE_TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const safeDate = Number.isNaN(d.getTime()) ? new Date() : d;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(safeDate);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function normalizeShipDateForAmazonConfirmShipment(value = new Date(), { now = new Date() } = {}) {
  const marketplaceToday = formatDateYmdInTimeZone(now);
  const raw = String(value || "").trim();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : formatDateYmdInTimeZone(value instanceof Date ? value : new Date(raw || now));
  return candidate > marketplaceToday ? marketplaceToday : candidate || marketplaceToday;
}

export function selectReadOnlyUploadFeedCsrfCapture({ cookieToken, storageToken, pageToken }) {
  if (String(cookieToken || "").trim()) return { token: String(cookieToken).trim(), source: "readOnlyCookie" };
  if (String(storageToken || "").trim()) return { token: String(storageToken).trim(), source: "readOnlyStorage" };
  return { token: String(pageToken || "").trim(), source: "readOnlyPage" };
}

export function getReadOnlyUploadFeedWarmupSelectors() {
  return [
    '[data-testid*="upload" i]',
    'button[aria-label*="upload" i]',
    'button',
  ];
}

export function getNativeUploadFormSelectors() {
  return {
    fileInput: "#fileToUpload",
    submit: 'input[name="upload"][type="submit"]',
  };
}

export function shouldNavigateSellerCentralFeedsTab({ currentUrl, targetUrl }) {
  return !String(currentUrl || "").startsWith(String(targetUrl || ""));
}

export function summarizeNativeUploadForm({ action, method, fileInputCount, submitControls, availableControls } = {}) {
  let actionPath = "";
  try {
    actionPath = new URL(String(action || ""), "https://sellercentral.amazon.com").pathname;
  } catch {}
  return {
    actionPath,
    method: String(method || "GET").toUpperCase(),
    fileInputCount: Number(fileInputCount || 0),
    submitControls: Array.isArray(submitControls) ? submitControls.map((value) => String(value || "").trim()).filter(Boolean) : [],
    availableControls: Array.isArray(availableControls) ? availableControls.map((value) => String(value || "").trim()).filter(Boolean) : [],
  };
}

export function buildSafeUploadFeedCsrfDiagnostic({ cookieNames = [], page = {} }) {
  const unique = (values) => [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const csrfNames = (values) => unique(values).filter((name) => /csrf|token/i.test(name));
  return {
    csrfCookieNames: csrfNames(cookieNames),
    csrfFormFields: csrfNames(page.formFields),
    localStorageKeys: csrfNames(page.localStorageKeys),
    sessionStorageKeys: csrfNames(page.sessionStorageKeys),
    windowKeys: csrfNames(page.windowKeys),
    scriptMentionsCsrf: page.scriptMentionsCsrf === true,
  };
}
