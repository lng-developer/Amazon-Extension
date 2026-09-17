export function createExtensionIdentity({ storage, randomUUID }) {
  let identityPromise;

  return () => {
    if (!identityPromise) {
      identityPromise = (async () => {
        let { clientId, clientLabel } = await storage.get(['clientId', 'clientLabel']);
        if (!clientId) clientId = `ext-${randomUUID()}`;
        if (!clientLabel) clientLabel = `Chrome ${clientId.slice(-6)}`;
        await storage.set({ clientId, clientLabel });
        return { clientId, clientLabel };
      })();
      identityPromise.catch(() => { identityPromise = null; });
    }
    return identityPromise;
  };
}
