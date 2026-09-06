export const DEFAULT_ENVIRONMENTS = {
  local: { ingestUrl: "http://localhost:3000", shopId: "", ingestToken: "", marketplaceCode: "US" },
  development: { ingestUrl: "https://dev-api.lngmerch.co", shopId: "", ingestToken: "", marketplaceCode: "US" },
  production: { ingestUrl: "", shopId: "", ingestToken: "", marketplaceCode: "US" },
};

export function normalizeBaseUrl(u) {
  if (!u) return "";
  return u
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/ext\/ingest(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
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
