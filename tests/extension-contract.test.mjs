import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_ENVIRONMENTS } from "../config.js";

const root = new URL("..", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("order import targets the current backend contract", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const background = read("background.js");
  const backendApi = read("backendApi.js");
  const config = read("config.js");

  assert.ok(manifest.host_permissions.includes("https://api.lngmerch.co/*"));
  assert.ok(manifest.host_permissions.includes("https://dev-api.lngmerch.co/*"));
  assert.equal(manifest.host_permissions.includes("https://*.trycloudflare.com/*"), false);
  assert.equal(manifest.host_permissions.includes("http://localhost:5000/*"), false);
  assert.match(config, /\/api\/integration\/external-order-imports\/manual-excel/);
  assert.match(backendApi, /Authorization: `Bearer \$\{token\}`/);
  assert.match(background, /fd\.append\("marketplaceCode", marketplaceCode \|\| "US"\)/);
});

test('extension icons use PNG logo assets', () => {
  const manifest = JSON.parse(read('manifest.json'));

  for (const iconPath of Object.values(manifest.icons)) {
    assert.match(iconPath, /^icons\/logo-\d+\.png$/);
    assert.ok(fs.existsSync(new URL(iconPath, root)));
  }
});

test('Ads debug output never prints captured credentials', () => {
  const adsBridge = read('ads_bridge.js');

  assert.doesNotMatch(adsBridge, /\[ADS\]\[DEBUG\]\[cfg\]/);
  assert.doesNotMatch(adsBridge, /captured headers -> storage\/candidate/);
  assert.doesNotMatch(adsBridge, /retrieveReport → headers\(use\)/);
});

test('Ads header sniffer captures CSRF headers returned by Amazon responses', () => {
  const sniffer = read('ads_main_sniffer.js');
  const bridge = read('ads_bridge.js');

  assert.match(sniffer, /response\.headers/);
  assert.match(sniffer, /getAllResponseHeaders/);
  assert.doesNotMatch(sniffer, /console\.log/);
  assert.doesNotMatch(bridge, /now - lastWrite < 300/);
});

test('Ads Reporting forwards its response CSRF token when creating a report', () => {
  const sniffer = read('ads_main_sniffer.js');
  const bridge = read('ads_bridge.js');
  const background = read('background.js');

  assert.match(sniffer, /'x-csrf-token': 'adsReportingCsrfToken'/);
  assert.match(background, /"x-csrf-token": "adsReportingCsrfToken"/);
  assert.match(bridge, /adsReportingCsrfToken/);
  assert.match(bridge, /h\["x-csrf-token"\] = adsReportingCsrfToken/);
});

test('Ads Reporting preflight does not require legacy Campaign API headers', () => {
  const background = read('background.js');

  assert.match(background, /function hasAdsReportingHeaders\(st = \{\}\) \{\s*return !!st\.adsReportingCsrfToken;/);
  assert.match(background, /async function ensureFreshAdsReportingHeaders\(\)/);
  assert.match(background, /await ensureFreshAdsReportingHeaders\(\);/);
});

test('Ads Reporting waits for its CSRF token instead of whole-page completion', () => {
  const background = read('background.js');
  const start = background.indexOf('async function forceRefreshAdsHeaders');
  const end = background.indexOf('async function ensureFreshAdsHeaders', start);
  const refresh = background.slice(start, end);

  assert.match(background, /async function waitForAdsReportingHeaders\(\)/);
  assert.match(refresh, /if \(reporting\) \{\s*headers = await waitForAdsReportingHeaders\(\);/);
});

test('Ads header sniffer is injected after the Reporting reload begins', () => {
  const background = read('background.js');
  const start = background.indexOf('async function reloadAdsTabForHeaderCapture');
  const end = background.indexOf('async function forceRefreshAdsHeaders', start);
  const reload = background.slice(start, end);

  assert.match(reload, /changeInfo\.status !== "loading"/);
  assert.match(reload, /await ensureAdsBridgeInjected\(tabId\)/);
  assert.match(reload, /await chrome\.tabs\.reload\(tabId\)/);
});

test('Ads Reporting uses the Reporting tab for token, report, and download operations', () => {
  const background = read('background.js');
  const refresh = background.slice(background.indexOf('async function forceRefreshAdsHeaders'), background.indexOf('async function ensureFreshAdsHeaders'));
  const reporting = background.slice(background.indexOf('async function adsReportingViaContentScript'), background.indexOf('async function downloadAdsReportCsv'));
  const download = background.slice(background.indexOf('async function downloadAdsReportCsv'), background.indexOf('async function runExportAdsSpendLocked'));

  assert.match(background, /async function ensureAdsReportingTab\(\)/);
  assert.match(background, /url: `\$\{ADS_BASE\}\/reporting`/);
  assert.match(refresh, /reporting \? ensureAdsReportingTab\(\) : ensureAdsTab\(\)/);
  assert.match(reporting, /await ensureAdsReportingTab\(\)/);
  assert.match(download, /await ensureAdsReportingTab\(\)/);
});

test('Ads import uses Amazon Reporting CSV instead of synthesizing campaign rows', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const background = read('background.js');
  const bridge = read('ads_bridge.js');

  assert.match(bridge, /ADS_REPORTING_REQUEST/);
  assert.match(bridge, /ADS_DOWNLOAD_LATEST_REPORT/);
  assert.match(background, /buildOneOffReportConfig/);
  assert.doesNotMatch(background, /campaignRowsToCsv/);
  assert.ok(manifest.host_permissions.includes('https://decorated-reports-prod-iad.s3.amazonaws.com/*'));
});

test('Ads Reporting bridge returns an error instead of leaving the import lock pending', () => {
  const bridge = read('ads_bridge.js');

  assert.match(bridge, /if \(msg\?\.type === 'ADS_REPORTING_REQUEST'\) \{\s*try \{/);
  assert.match(bridge, /sendResponse\(\{ ok: false, status: 0, message:/);
});

test('development-only build has the minimum Ads surface', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const html = read('options.html');
  const config = read('config.js');

  assert.equal(manifest.permissions.includes('cookies'), true);
  assert.equal(manifest.permissions.includes('webRequest'), false);
  assert.equal(manifest.host_permissions.includes('https://advertising.amazon.com/*'), true);
  const adsScripts = manifest.content_scripts?.filter((script) => script.matches?.includes('https://advertising.amazon.com/*')) || [];
  assert.ok(adsScripts.some((script) => script.js?.includes('ads_bridge.js') && script.run_at === 'document_start'));
  assert.ok(adsScripts.some((script) => script.js?.includes('ads_main_sniffer.js') && script.run_at === 'document_start' && script.world === 'MAIN'));
  assert.match(html, /data-tab="ads"/);
  assert.match(html, /btnExportAds/);
  assert.match(config, /development: \{ ingestUrl: "https:\/\/dev-api\.lngmerch\.co"/);
  assert.doesNotMatch(config, /production:/);
});

test("extension only persists the development backend configuration", () => {
  const options = read("options.js");
  const html = read("options.html");
  const config = read("config.js");

  assert.match(html, /id="environment"/);
  assert.match(html, /id="marketplaceCode"/);
  assert.match(html, /id="ingestToken"/);
  assert.match(options, /from [\x27"]\.\/config\.js[\x27"]/);
  assert.match(config, /development: \{ ingestUrl: "https:\/\/dev-api\.lngmerch\.co"/);
  assert.match(options, /ingestEnvironments/);
  assert.match(options, /marketplaceCode/);
  assert.match(options, /activeEnvironment/);
});

test('extension derives its shop from the access token', () => {
  const options = read('options.js');
  const html = read('options.html');
  const background = read('background.js');

  assert.doesNotMatch(html, /id="shopId"/);
  assert.doesNotMatch(options, /\$\('#shopId'\)/);
  assert.doesNotMatch(background, /fd\.append\("shopId"/);
  assert.doesNotMatch(background, /shopId,\s*salesChannelCode/);
});

test("transactions import targets finance transaction endpoint", () => {
  const background = read("background.js");
  const config = read("config.js");
  const html = read("options.html");

  assert.match(html, /id="transactionsDateFrom"/);
  assert.match(html, /id="transactionsDateTo"/);
  assert.match(html, /id="btnImportTransactions"/);
  assert.match(config, /\/api\/finance\/imports\/transactions/);
  assert.match(background, /RUN_TRANSACTIONS_IMPORT/);
  assert.match(background, /salesChannelCode: "AMAZON"/);
  assert.match(background, /marketplaceCode: marketplaceCode \|\| "US"/);
});

test("settlements import targets finance settlement endpoint", () => {
  const background = read("background.js");
  const config = read("config.js");
  const html = read("options.html");

  assert.match(html, /id="settlementsDateFrom"/);
  assert.match(html, /id="settlementsDateTo"/);
  assert.match(html, /id="btnImportSettlements"/);
  assert.match(config, /\/api\/finance\/imports\/settlements/);
  assert.match(background, /RUN_SETTLEMENTS_IMPORT/);
  assert.match(background, /salesChannelCode: "AMAZON"/);
  assert.match(background, /marketplaceCode: marketplaceCode \|\| "US"/);
});

test("backend API calls are centralized", () => {
  const background = read("background.js");
  const backendApi = read("backendApi.js");
  const config = read("config.js");

  assert.match(background, /from "\.\/backendApi\.js"/);
  assert.match(backendApi, /export async function postFileTo/);
  assert.match(backendApi, /export async function postOrderImport/);
  assert.match(backendApi, /Authorization: `Bearer \$\{token\}`/);
  assert.match(config, /transactionsImportUrl/);
  assert.match(config, /settlementsImportUrl/);
});

test("popup separates every operational flow into an accessible tab", () => {
  const html = read("options.html");
  const options = read("options.js");

  for (const tab of ["orders", "transactions", "settlements", "settings", "logs"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
    assert.match(html, new RegExp(`data-panel="${tab}"`));
  }
  assert.match(html, /role="tablist"/);
  assert.match(options, /activateTab/);
  const css = read("options.css").replace(/\s+/g, "");
  assert.match(css, /\.tabs\{[^}]*display:flex/);
  assert.match(css, /html,body\{[^}]*width:750px;height:600px/);
  assert.doesNotMatch(css, /min-height:100vh/);
  assert.match(css, /overflow-x:hidden/);
  assert.match(css, /\.app-shell\{[^}]*display:grid/);
  assert.match(css, /\.app-header\{[^}]*display:flex/);
  assert.match(css, /body\{[^}]*background:linear-gradient\(145deg,#d6f3f3,#43a6b1\)/);
  assert.match(css, /\.app-shell\{[^}]*background:#fff/);
  assert.match(css, /\.app-shell\{[^}]*border-radius:12px/);
  assert.match(css, /\.app-shell\{[^}]*box-shadow:/);
});

test('logs render grouped activity runs with expandable technical details', () => {
  const options = read('options.js');
  const html = read('options.html');
  const css = read('options.css');

  assert.match(options, /buildActivityRuns/);
  assert.match(options, /formatVietnamTime/);
  assert.match(html, /id="logEntries"/);
  assert.match(css, /\.activity-run/);
  assert.match(css, /\.activity-details/);
});

test("toolbar action opens the extension popup instead of a separate window", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const background = read("background.js");

  assert.equal(manifest.action.default_popup, "options.html");
  assert.equal(manifest.permissions.includes("windows"), false);
  assert.doesNotMatch(background, /chrome\.windows\.create/);
});

test("saving extension settings requests an immediate heartbeat", () => {
  const options = read("options.js");
  const background = read("background.js");

  assert.match(options, /HEARTBEAT_NOW/);
  assert.match(background, /msg\?\.type === "HEARTBEAT_NOW"/);
  assert.match(background, /await pollExtensionCommandsWithBackoff\(\{ force: true \}\)/);
  assert.match(background, /async function pollExtensionCommandsWithBackoff\(\{ force = false \} = \{\}\)/);
});

test("popup identifies its own extension and reports a failed local poll accurately", () => {
  const options = read("options.js");

  assert.match(options, /\[connectionStatusKey, 'clientId'\]/);
  assert.match(options, /Last poll failed/);
  assert.match(options, /result\?\.ok === false/);
});

test('missing API configuration is never reported as connected', () => {
  const background = read('background.js');
  const options = read('options.js');

  assert.match(background, /if \(!config\.ingestUrl \|\| !config\.ingestToken\)/);
  assert.match(background, /state: "NOT_CONFIGURED"/);
  assert.match(options, /state\?\.state === 'NOT_CONFIGURED'/);
});

test('Amazon report requests follow the session-establishing redirect', () => {
  const background = read('background.js');

  assert.doesNotMatch(background, /redirect:\s*["']manual["']/);
});

test('new-order report payload matches the Amazon FBM request', () => {
  const background = read('background.js');

  assert.match(background, /type:\s*["']fbmOrdersReport["']/);
  assert.doesNotMatch(background, /type:\s*["']newOrdersReport["']/);
});

test('order report polling allows up to three minutes for Amazon to finish', () => {
  const background = read('background.js');

  assert.match(background, /const REPORT_POLL_MAX_ATTEMPTS = 18;/);
  assert.match(background, /maxAttempts: REPORT_POLL_MAX_ATTEMPTS/);
});

test('order upload reads marketplace code from the extension configuration', () => {
  const background = read('background.js');
  const start = background.indexOf('async function runImportNewOrders');
  const end = background.indexOf('async function ensureAdsTab', start);
  const orderImport = background.slice(start, end);

  assert.match(orderImport, /const \{ ingestUrl, ingestToken, marketplaceCode \} = await getCfg\(\);/);
});

test("command polling keeps a stable extension identity", () => {
  const background = read("background.js");

  assert.match(background, /async function ensureIdentity\(\)/);
  assert.match(background, /chrome\.storage\.local\.get\(\["clientId", "clientLabel"\]\)/);
  assert.match(background, /chrome\.storage\.local\.set\(\{ clientId, clientLabel \}\)/);
});

test("extension command polling uses the LNG command API and current import flow", () => {
  const background = read("background.js");
  const client = read("extensionCommandClient.js");

  assert.match(background, /pollExtensionCommand/);
  assert.match(background, /runImport: \(numDays\) => runFullFlowAndEmitLogs\(numDays\)/);
  assert.match(background, /EXTENSION_COMMAND_POLL/);
  assert.match(client, /\/api\/integration\/extension-commands/);
  assert.match(client, /IMPORT_NEW_ORDERS/);
  assert.match(client, /Authorization: `Bearer \$\{token\}`/);
});

test("legacy realtime, FBM, tracking, and legacy-token APIs are absent", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const background = read("background.js");
  const backendApi = read("backendApi.js");
  const config = read("config.js");

  assert.equal(background.includes("Socket.IO"), false);
  assert.equal(background.includes("UPLOAD_TRACKING"), false);
  assert.equal(background.includes("IMPORT_FBM_ORDERS"), false);
  assert.equal(backendApi.includes("x-access-token"), false);
  assert.equal(config.includes("shipping-batch"), false);
  assert.equal(manifest.permissions.includes("webRequestBlocking"), false);
  assert.equal(manifest.permissions.includes("downloads"), false);
});
