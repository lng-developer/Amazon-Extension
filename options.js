import { DEFAULT_ENVIRONMENTS, normalizeBaseUrl } from './config.js';

const $ = (selector) => document.querySelector(selector);
const log = (message) => { $('#log').textContent = message; };
const today = () => new Date().toISOString().slice(0, 10);
const readConfig = (all, environment) => ({ ...DEFAULT_ENVIRONMENTS[environment], ...(all.ingestEnvironments?.[environment] || {}) });
const tabs = [...document.querySelectorAll('[data-tab]')];
const panels = [...document.querySelectorAll('[data-panel]')];

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
}

function fill(config) {
  $('#ingestUrl').value = config.ingestUrl || '';
  $('#shopId').value = config.shopId || '';
  $('#ingestToken').value = config.ingestToken || '';
  $('#marketplaceCode').value = config.marketplaceCode || 'US';
}

async function save() {
  const environment = $('#environment').value;
  const config = { ingestUrl: normalizeBaseUrl($('#ingestUrl').value), shopId: $('#shopId').value.trim(), ingestToken: $('#ingestToken').value.trim(), marketplaceCode: $('#marketplaceCode').value.trim().toUpperCase() || 'US' };
  const { ingestEnvironments = {} } = await chrome.storage.local.get('ingestEnvironments');
  await chrome.storage.local.set({ ...config, activeEnvironment: environment, ingestEnvironments: { ...ingestEnvironments, [environment]: config } });
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
  $('#btnImportNew').addEventListener('click', () => void send('AUTO_RUN_NOW'));
  $('#btnExportAds').addEventListener('click', () => void send('RUN_ADS_SPEND', { date: $('#adsDate').value }));
  $('#btnImportTransactions').addEventListener('click', () => void send('RUN_TRANSACTIONS_IMPORT', { dateFrom: $('#transactionsDateFrom').value, dateTo: $('#transactionsDateTo').value }));
  $('#btnImportSettlements').addEventListener('click', () => void send('RUN_SETTLEMENTS_IMPORT', { dateFrom: $('#settlementsDateFrom').value, dateTo: $('#settlementsDateTo').value }));
});
