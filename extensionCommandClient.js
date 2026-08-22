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

export async function pollExtensionCommand({ base, token, client, runImport, fetchImpl = fetch }) {
  if (!base || !token || !client?.clientId || !client?.label) return null;
  const root = `${base.replace(/\/+$/, '')}${COMMAND_PATH}`;
  await request(fetchImpl, `${root}/agent/heartbeat`, token, 'POST', client);
  const claim = await request(fetchImpl, `${root}/agent/claim`, token, 'POST', client);
  if (!claim?.command) return null;

  const command = claim.command;
  const lease = { ...client, leaseToken: claim.leaseToken };
  await request(fetchImpl, `${root}/agent/commands/${command.id}/start`, token, 'POST', lease);
  try {
    if (command.type !== 'IMPORT_NEW_ORDERS') throw new Error(`Unsupported command: ${command.type}`);
    const outcome = await runImport();
    const importJobId = outcome?.result?.jobId || outcome?.result?.data?.jobId || outcome?.result?.ingest?.data?.jobId || null;
    const importedCount = Number(outcome?.result?.rows || 0);
    await request(fetchImpl, `${root}/agent/commands/${command.id}/complete`, token, 'POST', {
      ...lease, success: true, importJobId, importedCount, failedCount: 0,
    });
    return { id: command.id, status: 'SUCCEEDED' };
  } catch (error) {
    await request(fetchImpl, `${root}/agent/commands/${command.id}/complete`, token, 'POST', {
      ...lease, success: false, importedCount: 0, failedCount: 1, errorMessage: error?.message || 'Extension task failed',
    });
    throw error;
  }
}
