(() => {
  if (window.__APO_ADS_MAIN_WORLD_SNIFFER__) return;
  window.__APO_ADS_MAIN_WORLD_SNIFFER__ = true;

  const headerMap = {
    'amazon-ads-account-id': 'adsAccountId',
    'amazon-advertising-api-advertiserid': 'adsAdvertiserId',
    'amazon-advertising-api-clientid': 'adsClientId',
    'amazon-advertising-api-marketplaceid': 'adsMarketplaceId',
    'amazon-advertising-api-csrf-data': 'adsCsrfData',
    'amazon-advertising-api-csrf-token': 'adsCsrfToken',
    'x-csrf-token': 'adsReportingCsrfToken',
  };

  const normalize = (headers) => {
    const result = {};
    try {
      if (typeof headers === 'string') headers.split(/\r?\n/).forEach((line) => {
        const separator = line.indexOf(':');
        if (separator > 0) result[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      });
      else if (headers instanceof Headers) headers.forEach((value, key) => { result[String(key).toLowerCase()] = String(value); });
      else if (Array.isArray(headers)) headers.forEach(([key, value]) => { result[String(key).toLowerCase()] = String(value); });
      else Object.entries(headers || {}).forEach(([key, value]) => { result[String(key).toLowerCase()] = String(value); });
    } catch (_) {}
    return result;
  };

  const publish = (headers) => {
    const normalized = normalize(headers);
    const data = Object.fromEntries(Object.entries(headerMap)
      .filter(([header]) => normalized[header])
      .map(([header, key]) => [key, normalized[header]]));
    if (Object.keys(data).length) window.postMessage({ __apo: true, type: 'APO_ADS_HEADER_SNIFF', data }, location.origin);
  };

  const isAdsRequest = (url) => {
    try { return new URL(url, location.href).host === 'advertising.amazon.com'; } catch (_) { return false; }
  };

  const publishDownloadUrl = (url) => {
    try {
      const parsed = new URL(url, location.href);
      if (!/amazonaws\.com$/i.test(parsed.hostname)) return;
      window.postMessage({ __apo: true, type: 'APO_ADS_DOWNLOAD_URL', url: parsed.href }, location.origin);
    } catch (_) {}
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (anchor) publishDownloadUrl(anchor.href);
  }, true);

  const nativeOpenWindow = window.open;
  window.open = function (url) {
    publishDownloadUrl(url);
    return nativeOpenWindow.apply(this, arguments);
  };

  const nativeFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url;
    if (url && isAdsRequest(url)) publish({ ...normalize(input?.headers), ...normalize(init?.headers) });
    return nativeFetch.apply(this, arguments).then((response) => {
      if (url && isAdsRequest(url)) publish(response.headers);
      return response;
    });
  };

  const open = XMLHttpRequest.prototype.open;
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__apoAdsUrl = url;
    this.__apoAdsHeaders = {};
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.__apoAdsHeaders[String(name).toLowerCase()] = String(value);
    return setRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__apoAdsUrl && isAdsRequest(this.__apoAdsUrl)) {
      publish(this.__apoAdsHeaders);
      this.addEventListener('loadend', () => publish(this.getAllResponseHeaders()));
    }
    return send.apply(this, arguments);
  };
})();
