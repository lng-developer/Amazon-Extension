import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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

test('Ads debug output never prints captured credentials', () => {
  const adsBridge = read('ads_bridge.js');

  assert.doesNotMatch(adsBridge, /\[ADS\]\[DEBUG\]\[cfg\]/);
  assert.doesNotMatch(adsBridge, /captured headers -> storage\/candidate/);
  assert.doesNotMatch(adsBridge, /retrieveReport → headers\(use\)/);
});

test("each environment keeps its own backend configuration", () => {
  const options = read("options.js");
  const html = read("options.html");
  const config = read("config.js");

  assert.match(html, /id="environment"/);
  assert.match(html, /id="marketplaceCode"/);
  assert.match(html, /id="ingestToken"/);
  assert.match(options, /from [\x27"]\.\/config\.js[\x27"]/);
  assert.match(config, /production: \{ ingestUrl: "https:\/\/api\.lngmerch\.co"/);
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

  for (const tab of ["orders", "ads", "transactions", "settlements", "settings", "logs"]) {
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
