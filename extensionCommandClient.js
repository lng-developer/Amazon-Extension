const COMMAND_PATH = '/api/integration/extension-commands';

async function request(fetchImpl, url, token, method, body) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.stack?.split('\n')[0] || payload?.error?.message || `Backend ${response.status}`;
    const requestId = payload?.error?.requestId ? ` (request ${payload.error.requestId})` : '';
    throw new Error(`${detail}${requestId}`);
  }
  return payload?.data;
}

export async function queueOrderImportCommand({ base, token, client, fetchImpl = fetch }) {
  if (!base || !token || !client?.clientId || !client?.label) throw new Error('Extension connection is not configured');
  const root = `${base.replace(/\/+$/, '')}${COMMAND_PATH}`;
  return request(fetchImpl, `${root}/agent/import-new-orders`, token, 'POST', { ...client, numDays: 1 });
}

export async function queueAdsSpendCommand({ base, token, client, date, fetchImpl = fetch }) {
  if (!base || !token || !client?.clientId || !client?.label || !date) throw new Error('Development Ads import is not configured');
  const root = `${base.replace(/\/+$/, '')}${COMMAND_PATH}`;
  return request(fetchImpl, `${root}/agent/import-ads-spend`, token, 'POST', { ...client, dateFrom: date, dateTo: date });
}

export async function pollExtensionCommand({ base, token, client, runImport, runAds, runTransactions, runSettlements, fetchImpl = fetch }) {
  if (!base || !token || !client?.clientId || !client?.label) return null;
  const root = `${base.replace(/\/+$/, '')}${COMMAND_PATH}`;
  await request(fetchImpl, `${root}/agent/heartbeat`, token, 'POST', client);
  const claim = await request(fetchImpl, `${root}/agent/claim`, token, 'POST', client);
  if (!claim?.command) return null;

  const command = claim.command;
  const lease = { ...client, leaseToken: claim.leaseToken };
  await request(fetchImpl, `${root}/agent/commands/${command.id}/start`, token, 'POST', lease);
  try {
    if (!['IMPORT_NEW_ORDERS', 'IMPORT_ADS_SPEND', 'IMPORT_TRANSACTIONS', 'IMPORT_SETTLEMENTS', 'TEST_CONNECTION'].includes(command.type)) {
      throw new Error(`Unsupported command: ${command.type}`);
    }
    const outcome = command.type === 'IMPORT_NEW_ORDERS'
      ? await runImport(command.numDays || 1)
      : command.type === 'IMPORT_ADS_SPEND'
        ? await runAds({ dateFrom: command.dateFrom, dateTo: command.dateTo })
        : command.type === 'IMPORT_TRANSACTIONS'
          ? await runTransactions({ dateFrom: command.dateFrom, dateTo: command.dateTo })
          : command.type === 'IMPORT_SETTLEMENTS'
            ? await runSettlements({ dateFrom: command.dateFrom, dateTo: command.dateTo })
        : null;
    const result = outcome?.data || outcome?.result || outcome;
    const importJobId = result?.id || result?.importBatchId || result?.jobId || result?.data?.jobId || result?.ingest?.data?.jobId || null;
    const importedCount = Number(result?.importedCount ?? result?.processedRows ?? result?.rows ?? 0);
    const failedCount = Number(result?.failedCount ?? result?.errorCount ?? 0);
    await request(fetchImpl, `${root}/agent/commands/${command.id}/complete`, token, 'POST', {
      ...lease, success: true, importJobId, importedCount, failedCount,
    });
    return { id: command.id, status: 'SUCCEEDED' };
  } catch (error) {
    await request(fetchImpl, `${root}/agent/commands/${command.id}/complete`, token, 'POST', {
      ...lease, success: false, importedCount: 0, failedCount: 1, errorMessage: error?.message || 'Extension task failed',
    });
    throw error;
  }
}
