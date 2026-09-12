document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) return;
  chrome.runtime.sendMessage({ type: 'GMAIL_AMAZON_ADS_DOWNLOAD', url: link.href }).catch(() => undefined);
}, true);
