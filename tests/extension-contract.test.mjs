import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("order import targets the current backend contract", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const background = read("background.js");

  assert.ok(manifest.host_permissions.includes("https://*.trycloudflare.com/*"));
  assert.match(background, /\/api\/integration\/external-order-imports\/manual-excel/);
  assert.match(background, /Authorization: `Bearer \$\{ingestToken\}`/);
  assert.match(background, /fd\.append\("marketplaceCode", marketplaceCode \|\| "US"\)/);
});

test("each environment keeps its own backend configuration", () => {
  const options = read("options.js");
  const html = read("options.html");

  assert.match(html, /id="environment"/);
  assert.match(html, /id="marketplaceCode"/);
  assert.match(html, /id="ingestToken"/);
  assert.match(options, /ingestEnvironments/);
  assert.match(options, /marketplaceCode/);
  assert.match(options, /activeEnvironment/);
});

test("transactions import targets finance transaction endpoint", () => {
  const background = read("background.js");
  const html = read("options.html");

  assert.match(html, /id="transactionsDateFrom"/);
  assert.match(html, /id="transactionsDateTo"/);
  assert.match(html, /id="btnImportTransactions"/);
  assert.match(background, /\/api\/finance\/imports\/transactions/);
  assert.match(background, /RUN_TRANSACTIONS_IMPORT/);
  assert.match(background, /salesChannelCode: "AMAZON"/);
  assert.match(background, /marketplaceCode: marketplaceCode \|\| "US"/);
});

test("settlements import targets finance settlement endpoint", () => {
  const background = read("background.js");
  const html = read("options.html");

  assert.match(html, /id="settlementsDateFrom"/);
  assert.match(html, /id="settlementsDateTo"/);
  assert.match(html, /id="btnImportSettlements"/);
  assert.match(background, /\/api\/finance\/imports\/settlements/);
  assert.match(background, /RUN_SETTLEMENTS_IMPORT/);
  assert.match(background, /salesChannelCode: "AMAZON"/);
  assert.match(background, /marketplaceCode: marketplaceCode \|\| "US"/);
});
