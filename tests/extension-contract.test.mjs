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
  assert.match(background, /fd\.append\("marketplaceCode", "AMAZON"\)/);
});

test("each environment keeps its own backend configuration", () => {
  const options = read("options.js");
  const html = read("options.html");

  assert.match(html, /id="environment"/);
  assert.match(html, /id="ingestToken"/);
  assert.match(options, /ingestEnvironments/);
  assert.match(options, /activeEnvironment/);
});
