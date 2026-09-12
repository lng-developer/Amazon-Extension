export const DEFAULT_ENVIRONMENTS = {
  development: { ingestUrl: "https://dev-api.lngmerch.co", shopId: "", ingestToken: "", marketplaceCode: "US" },
};

export const DEVELOPMENT_API_URLS = [
  "https://dev-api.lngmerch.co",
  "http://localhost:3001",
];

export function normalizeBaseUrl(u) {
  if (!u) return "";
  return u
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/ext\/ingest(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

export function resolveDevelopmentApiUrl(value) {
  const base = normalizeBaseUrl(value);
  return DEVELOPMENT_API_URLS.includes(base) ? base : DEFAULT_ENVIRONMENTS.development.ingestUrl;
}

export function deriveApiUrls(ingestUrl) {
  const base = normalizeBaseUrl(ingestUrl);
  return {
    base,
    importNewUrl: base ? `${base}/api/integration/external-order-imports/manual-excel` : "",
    adsSpendUrl: base ? `${base}/api/finance/imports/ads` : "",
    transactionsImportUrl: base ? `${base}/api/finance/imports/transactions` : "",
    settlementsImportUrl: base ? `${base}/api/finance/imports/settlements` : "",
  };
}
