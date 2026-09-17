import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('failed history refresh discards cached nonterminal authority but retains final states', async () => {
  const source = fs.readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function refreshActivityCommands()');
  const end = source.indexOf('async function renderOrderImportProgress()', start);
  for (const response of [async () => ({ ok: false }), async () => { throw new Error('Offline'); }]) {
    const context = vm.createContext({
      activityRefreshPending: false,
      activityCommands: [{ id: 'a', status: 'RUNNING' }, { id: 'b', status: 'FAILED' }],
      chrome: { runtime: { sendMessage: response } }, renderLogs: async () => {},
    });
    await vm.runInContext(`${source.slice(start, end)}; refreshActivityCommands()`, context);
    assert.deepEqual(Array.from(context.activityCommands, x => x.id), ['b']);
    assert.equal(context.activityRefreshPending, false);
  }
});
