const IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGE_PATH = '/api/integration/listing-image-sync';
const fatalCodes = new Set(['AMAZON_CHALLENGE', 'AMAZON_AUTH_REQUIRED', 'AMAZON_RATE_LIMIT']);
const imageError = (code, message) => Object.assign(new Error(message), { code });

// Self-contained: Chrome serializes this function into the product page.
export function inspectListingMainImage(expectedAsin) {
  const text = (document.body?.innerText || '').slice(0, 12000);
  if (document.querySelector('form[action*="validateCaptcha"],#captchacharacters')
    || /enter the characters you see|sorry, we just need to make sure|automated access/i.test(text)) {
    return { errorCode: 'AMAZON_CHALLENGE', errorMessage: 'Amazon requires CAPTCHA or access verification; resolve it in Chrome before resuming.' };
  }
  if (location.pathname.startsWith('/ap/')) return { errorCode: 'AMAZON_AUTH_REQUIRED', errorMessage: 'Sign in to Amazon in Chrome before resuming.' };
  if (/too many requests|request was throttled/i.test(text)) return { errorCode: 'AMAZON_RATE_LIMIT', errorMessage: 'Amazon rate limited image requests. Resume later.' };
  if (location.hostname !== 'www.amazon.com') return { errorCode: 'ASIN_MISMATCH', errorMessage: 'Amazon redirected to another marketplace.' };
  const pathAsin = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  const asin = document.querySelector('#ASIN')?.value?.toUpperCase();
  if (pathAsin !== expectedAsin || (asin && asin !== expectedAsin)) return { errorCode: 'ASIN_MISMATCH', errorMessage: 'Amazon page ASIN does not match the requested listing.' };
  const img = document.querySelector('#landingImage');
  if (!img || !img.complete || !img.naturalWidth || !asin) return { pending: true };
  let candidates = [];
  try { candidates = Object.entries(JSON.parse(img.getAttribute('data-a-dynamic-image') || '{}')).sort((a,b) => b[1][0]*b[1][1] - a[1][0]*a[1][1]); } catch { /* src remains available */ }
  let errorMessage = 'Amazon MAIN image has no URL.';
  for (const [sourceKind, sourceUrl] of [
    ['data-old-hires', img.getAttribute('data-old-hires')],
    ...candidates.map(([value]) => ['data-a-dynamic-image', value]),
    ['src', img.getAttribute('src')],
  ]) {
    if (!sourceUrl) continue;
    let diagnostic = `${sourceKind}; valueType=${typeof sourceUrl}`;
    try {
      const url = new URL(sourceUrl);
      // Never include URL credentials, query, fragment, or arbitrary path in logs.
      diagnostic = `${sourceKind}; protocol=${url.protocol}; host=${url.hostname.slice(0,80)}; path=${url.pathname.startsWith('/images/I/') ? '/images/I/' : url.pathname.startsWith('/images/S/') ? '/images/S/' : 'other'}; port=${url.port || 'default'}; credentials=${!!(url.username || url.password)}`;
      if (url.protocol !== 'https:' || url.hostname !== 'm.media-amazon.com' || url.port || url.username || url.password) throw new Error('Untrusted image');
      return { asin, sourceUrl: url.href };
    } catch (error) { errorMessage = `Amazon MAIN image URL is not trusted (${diagnostic}; parse=${error.name}).`.slice(0,300); }
  }
  return { errorCode: 'INVALID_IMAGE_URL', errorMessage };
}

export async function downloadListingImage(sourceUrl, { fetchImpl = fetch, maxBytes = IMAGE_LIMIT, signal } = {}) {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'm.media-amazon.com' || url.port || url.username || url.password) throw imageError('INVALID_IMAGE_URL', 'Image URL is not trusted');
  const timeout = AbortSignal.timeout(60000);
  const response = await fetchImpl(url.href, { credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (response.redirected) throw imageError('INVALID_IMAGE_URL', 'Image redirect is not allowed');
  if (response.status === 429 || response.status === 503) throw imageError('AMAZON_RATE_LIMIT', 'Amazon image requests are rate limited');
  if (!response.ok) throw imageError('IMAGE_DOWNLOAD_FAILED', `Image download failed (${response.status})`);
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw imageError('INVALID_IMAGE', 'Response is not a supported image');
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw imageError('IMAGE_TOO_LARGE', 'Image is too large'); }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw imageError('IMAGE_TOO_LARGE', 'Image is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!size) throw imageError('INVALID_IMAGE', 'Amazon returned an empty image');
  return new Blob(chunks, { type: mime });
}

async function backendRequest(fetchImpl, url, token, signal, body) {
  const multipart = body instanceof FormData;
  const response = await fetchImpl(url, { method: body ? 'POST' : 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(body ? 120000 : 30000)]),
    headers: { Authorization: `Bearer ${token}`, ...(body && !multipart ? {'Content-Type':'application/json'} : {}) },
    ...(body ? {body: multipart ? body : JSON.stringify(body)} : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw imageError('BACKEND_ERROR', payload?.error?.message || `Backend rejected image sync (${response.status})`);
  return payload?.data;
}

export async function runListingImageBatch({ base, token, client, command, leaseToken, onProgress,
  chromeApi = chrome, fetchImpl = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const root = `${base.replace(/\/+$/, '')}${IMAGE_PATH}/agent/commands/${encodeURIComponent(command.id)}`;
  const lease = { clientId: client.clientId, leaseToken };
  const controller = new AbortController();
  const signal = controller.signal;
  let ownedTab;
  let renewing = false;
  let leaseError;
  let importedCount = 0;
  let failedCount = 0;
  const renew = async () => {
    if (renewing || leaseError) return;
    renewing = true;
    try { await onProgress({stage:'LISTING_IMAGES'}); }
    catch(error) { leaseError = error; controller.abort(error); }
    finally { renewing = false; }
  };
  const checkLease = () => { if (leaseError) throw leaseError; signal.throwIfAborted(); };
  await renew(); checkLease();
  const timer = setInterval(() => { void renew(); }, 30000);
  const request = (path, body) => backendRequest(fetchImpl, `${root}${path}`, token, signal, body);
  try {
    const handled = new Set();
    for (let index=0; index<25; index++) {
      checkLease();
      const state = await request('/items/query', lease);
      if (state?.status === 'PAUSED') break;
      if (!Array.isArray(state?.items)) throw new Error('Invalid image sync batch response');
      const item = state.items.find(value => !handled.has(value.id));
      if (!item) break;
      if (item.marketplaceCode !== 'US' || !/^[A-Z0-9]{10}$/.test(item.asin)) throw new Error('Unsupported listing identity in image sync batch');
      let image;
      let blob;
      try {
        if (!ownedTab) ownedTab = await chromeApi.tabs.create({url:'about:blank',active:false});
        await chromeApi.tabs.update(ownedTab.id,{url:`https://www.amazon.com/dp/${item.asin}`});
        for (let attempt=0; attempt<120; attempt++) {
          checkLease();
          if ((await chromeApi.tabs.get(ownedTab.id)).status === 'complete') {
            const execution = await chromeApi.scripting.executeScript({target:{tabId:ownedTab.id},func:inspectListingMainImage,args:[item.asin]});
            image = execution?.[0]?.result;
            if (image?.errorCode) throw imageError(image.errorCode, image.errorMessage);
            if (image?.sourceUrl) break;
          }
          if (attempt === 119) throw imageError('IMAGE_NOT_FOUND', 'MAIN image or exact ASIN did not become available within 60 seconds');
          await delay(500);
        }
        blob = await downloadListingImage(image.sourceUrl, { fetchImpl, signal });
      } catch(error) {
        checkLease();
        if (ownedTab) {
          try { await chromeApi.tabs.get(ownedTab.id); }
          catch {
            await request('/pause',{...lease,errorMessage:'Amazon worker tab is unavailable. Resume to open a new tab.'});
            throw imageError('AMAZON_TAB_UNAVAILABLE', 'Amazon worker tab is unavailable. Resume to open a new tab.');
          }
        }
        if (fatalCodes.has(error.code)) {
          await request('/pause',{...lease,errorMessage:error.message.slice(0,1000)});
          throw error;
        }
        await request(`/items/${encodeURIComponent(item.id)}/result`,{...lease,asin:item.asin,errorCode:error.code || 'IMAGE_FETCH_FAILED',errorMessage:error.message.slice(0,1000)});
        failedCount++; handled.add(item.id); continue;
      }
      checkLease();
      const form = new FormData();
      for(const [key,value] of Object.entries({...lease,asin:item.asin,sourceUrl:image.sourceUrl})) form.append(key,value);
      const extension = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[blob.type];
      form.append('file',blob,`${item.asin}.${extension}`);
      const result = await request(`/items/${encodeURIComponent(item.id)}/result`,form);
      if (!['SUCCEEDED','UNCHANGED','SKIPPED','FAILED'].includes(result?.status)) throw new Error('Backend did not acknowledge image result');
      if (result.status === 'FAILED') failedCount++;
      else if (result.status === 'SUCCEEDED' || result.status === 'UNCHANGED') importedCount++;
      handled.add(item.id);
    }
    return {importedCount,failedCount};
  } finally {
    clearInterval(timer);
    controller.abort();
    if(ownedTab?.id) await chromeApi.tabs.remove(ownedTab.id).catch(()=>{});
  }
}
