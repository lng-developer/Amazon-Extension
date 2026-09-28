export async function stopAmazonFeedWatches({ storage, alarms, watchesKey, alarmName }) {
  const stored = await storage.get([watchesKey]);
  const watches = stored[watchesKey] && typeof stored[watchesKey] === "object" ? stored[watchesKey] : {};
  await storage.set({ [watchesKey]: {} });
  const alarmCleared = await alarms.clear(alarmName);
  return { watchesCleared: Object.keys(watches).length, alarmCleared: !!alarmCleared };
}

export async function finalizeAmazonFeedWatch({
  storage,
  alarms,
  removeTab,
  watchesKey,
  pendingEventsKey,
  alarmName,
  watch,
  event,
  acknowledged,
  tabId,
}) {
  const stored = await storage.get([watchesKey, pendingEventsKey]);
  const watches = stored[watchesKey] && typeof stored[watchesKey] === "object" ? stored[watchesKey] : {};
  const pendingEvents = stored[pendingEventsKey] && typeof stored[pendingEventsKey] === "object" ? stored[pendingEventsKey] : {};
  delete watches[watch.batchId];
  if (acknowledged) delete pendingEvents[watch.batchId];
  else pendingEvents[watch.batchId] = { watch, event };
  await storage.set({ [watchesKey]: watches, [pendingEventsKey]: pendingEvents });

  const alarmCleared = Object.keys(watches).length === 0
    ? !!await alarms.clear(alarmName)
    : false;
  const tabClosed = !!(watch.createdDedicatedTab && tabId && await removeTab(tabId).then(() => true).catch(() => false));
  return { queued: !acknowledged, watchRemoved: true, tabClosed, alarmCleared };
}
