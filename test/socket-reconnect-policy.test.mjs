import test from "node:test";
import assert from "node:assert/strict";
import { shouldReconnectSocket } from "../lib/socket-reconnect-policy.js";

test("reconnects an offline socket only when auto-connect is enabled", () => {
  assert.equal(shouldReconnectSocket({ autoConnect: true, connected: false }), true);
  assert.equal(shouldReconnectSocket({ autoConnect: undefined, connected: false }), true);
  assert.equal(shouldReconnectSocket({ autoConnect: false, connected: false }), false);
  assert.equal(shouldReconnectSocket({ autoConnect: true, connected: true }), false);
});
