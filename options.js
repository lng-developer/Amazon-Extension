import { DEFAULT_ENVIRONMENTS, normalizeBaseUrl } from './config.js';
import { buildActivityRuns, createExtensionLogger, formatVietnamTime } from './extensionLogger.js';

const $ = (selector) => document.querySelector(selector);
const log = (message) => { $('#log').textContent = message; };
const today = () => new Date().toISOString().slice(0, 10);
const readConfig = (all, environment) => ({ ...DEFAULT_ENVIRONMENTS[environment], ...(all.ingestEnvironments?.[environment] || {}) });
const tabs = [...document.querySelectorAll('[data-tab]')];
const panels = [...document.querySelectorAll('[data-panel]')];
const extensionLogger = createExtensionLogger({ storage: chrome.storage.local });
const connectionStatusKey = 'extensionConnectionStatus';
function relativeTime(target) { const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000)); return seconds ? `in ${seconds}s` : 'now'; }
async function renderConnectionStatus() {
  const stored = await chrome.storage.local.get([connectionStatusKey, 'clientId']);
  const state = stored[connectionStatusKey];
  const agent = stored.clientId ? `Ext …${stored.clientId.slice(-6)} · ` : '';
  $('#beConnection').textContent = state?.state === 'CONNECTED'
    ? `${agent}BE: Connected · last heartbeat ${new Date(state.lastHeartbeatAt).toLocaleTimeString()}`
    : `${agent}BE: Last poll failed`;
  $('#bePoll').textContent = `Next poll: ${state?.nextPollAt ? relativeTime(state.nextPollAt) : '-'}`;
}

async function renderLogs() {
  const events = await extensionLogger.getEvents();
  const container = $('#logEntries');
  const runs = buildActivityRuns(events);
  container.replaceChildren();
  if (!runs.length) {
    container.textContent = 'No activity yet.';
    return;
  }
  [...runs].reverse().forEach((run) => {
    const card = document.createElement('article');
    card.className = `activity-run is-${run.status.toLowerCase()}`;
    const header = document.createElement('div');
    header.className = 'activity-run-header';
    const title = document.createElement('strong');
    title.textContent = run.label;
    const status = document.createElement('span');
    status.className = 'activity-status';
    status.textContent = run.status;
    header.append(title, status);
    const meta = document.createElement('p');
    const batchId = run.events[0]?.context?.batchId;
    meta.textContent = `${formatVietnamTime(run.startedAt)}${batchId ? ` · ${batchId}` : ''}`;
    card.append(header, meta);
    if (run.error) {
      const error = document.createElement('p');
      error.className = 'activity-error';
      error.textContent = run.error;
      card.append(error);
    }
    const details = document.createElement('details');
    details.className = 'activity-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Technical details';
    const raw = document.createElement('pre');
    raw.textContent = run.events.map((event) => `${event.timestamp} ${event.level.toUpperCase()} ${event.message}${event.context ? ` ${JSON.stringify(event.context)}` : ''}`).join('\n');
    details.append(summary, raw);
    card.append(details);
    container.append(card);
  });
}

function activateTab(name) {
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  panels.forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (name === 'logs') void renderLogs();
}

function fill(config) {
  $('#ingestUrl').value = config.ingestUrl || '';
  $('#ingestToken').value = config.ingestToken || '';
  $('#marketplaceCode').value = config.marketplaceCode || 'US';
}

async function save() {
  const environment = $('#environment').value;
  const config = { ingestUrl: normalizeBaseUrl($('#ingestUrl').value), ingestToken: $('#ingestToken').value.trim(), marketplaceCode: $('#marketplaceCode').value.trim().toUpperCase() || 'US' };
  const { ingestEnvironments = {} } = await chrome.storage.local.get('ingestEnvironments');
  const cleanedEnvironments = Object.fromEntries(Object.entries(ingestEnvironments).map(([name, value]) => {
    const { shopId: _shopId, ...savedConfig } = value;
    return [name, savedConfig];
  }));
  await chrome.storage.local.remove('shopId');
  await chrome.storage.local.set({ ...config, activeEnvironment: environment, ingestEnvironments: { ...cleanedEnvironments, [environment]: config } });
  log('Checking connection…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'HEARTBEAT_NOW' });
    log(result?.ok ? 'Connected. Heartbeat received.' : `Heartbeat failed: ${result?.error || 'Unknown error'}`);
  } catch (error) {
    log(`Heartbeat failed: ${error?.message || String(error)}`);
  }
}

async function send(type, payload = {}) {
  const button = document.activeElement;
  if (button?.tagName === 'BUTTON') button.disabled = true;
  log('Starting…');
  try {
    const result = await chrome.runtime.sendMessage({ type, payload });
    log(result?.ok ? 'Started.' : `Failed: ${result?.error || 'Unknown error'}`);
  } finally {
    if (button?.tagName === 'BUTTON') button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const all = await chrome.storage.local.get(['activeEnvironment', 'ingestEnvironments']);
  const environment = all.activeEnvironment || 'development';
  $('#environment').value = environment;
  fill(readConfig(all, environment));
  $('#adsDate').value = today();
  tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  $('#environment').addEventListener('change', () => fill(readConfig(all, $('#environment').value)));
  $('#btnSave').addEventListener('click', () => void save());
  $('#btnCheckNow').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'HEARTBEAT_NOW' }); await renderConnectionStatus(); });
  $('#btnImportNew').addEventListener('click', () => void send('AUTO_RUN_NOW'));
  $('#btnExportAds').addEventListener('click', () => void send('RUN_ADS_SPEND', { date: $('#adsDate').value }));
  $('#btnImportTransactions').addEventListener('click', () => void send('RUN_TRANSACTIONS_IMPORT', { dateFrom: $('#transactionsDateFrom').value, dateTo: $('#transactionsDateTo').value }));
  $('#btnImportSettlements').addEventListener('click', () => void send('RUN_SETTLEMENTS_IMPORT', { dateFrom: $('#settlementsDateFrom').value, dateTo: $('#settlementsDateTo').value }));
  $('#btnCopyLogs').addEventListener('click', async () => {
    const events = await extensionLogger.getEvents();
    await navigator.clipboard.writeText([...events].reverse().map((event) => `${event.timestamp} ${event.level.toUpperCase()} ${event.message}${event.context ? ` ${JSON.stringify(event.context)}` : ''}`).join('\n'));
    log('Logs copied.');
  });
  $('#btnClearLogs').addEventListener('click', async () => {
    await extensionLogger.clear();
    await renderLogs();
    log('Logs cleared.');
  });
  await renderConnectionStatus();
  window.setInterval(() => void renderConnectionStatus(), 1000);
});
