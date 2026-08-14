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
  assert.ok(manifest.host_permissions.includes("https://*.trycloudflare.com/*"));
  assert.match(config, /\/api\/integration\/external-order-imports\/manual-excel/);
  assert.match(backendApi, /Authorization: `Bearer \$\{token\}`/);
  assert.match(background, /fd\.append\("marketplaceCode", marketplaceCode \|\| "US"\)/);
});

test("each environment keeps its own backend configuration", () => {
  const options = read("options.js");
  const html = read("options.html");
  const config = read("config.js");

  assert.match(html, /id="environment"/);
  assert.match(html, /id="marketplaceCode"/);
  assert.match(html, /id="ingestToken"/);
  assert.match(options, /from "\.\/config\.js"/);
  assert.match(config, /production: \{ ingestUrl: "https:\/\/api\.lngmerch\.co"/);
  assert.match(config, /development: \{ ingestUrl: "https:\/\/dev-api\.lngmerch\.co"/);
  assert.match(options, /ingestEnvironments/);
  assert.match(options, /marketplaceCode/);
  assert.match(options, /activeEnvironment/);
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
  assert.match(backendApi, /export async function postFbmImport/);
  assert.match(backendApi, /export async function checkOrdersStatus/);
  assert.match(backendApi, /export async function createShippingBatch/);
  assert.match(backendApi, /export async function fetchEmployeeCodesFromBackend/);
  assert.match(backendApi, /export async function postExtensionLog/);
  assert.match(config, /checkOrdersStatusUrl/);
  assert.match(config, /createShippingBatchUrl/);
  assert.match(config, /logUrl/);
});
