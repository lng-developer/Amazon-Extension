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
