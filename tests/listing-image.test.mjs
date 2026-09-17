import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as images from '../amazonListingImage.js';

const asin = 'B0H9WGN6MM';
const url = 'https://m.media-amazon.com/images/I/71mTwyEqu7L._AC_SL1254_.jpg';
function extract({ image = { 'data-old-hires': url }, pageAsin = asin, challenge = false } = {}) {
  const document = { body: { innerText: challenge ? 'Enter the characters you see below' : 'Product' },
    querySelector: selector => selector === '#landingImage' ? { getAttribute: key => image[key] || null, complete: true, naturalWidth: 1254 }
      : selector === '#ASIN' ? { value: pageAsin } : null };
  return vm.runInNewContext(`(${images.inspectListingMainImage.toString()})('${asin}')`, {
    document, location: { href: `https://www.amazon.com/dp/${asin}`, hostname: 'www.amazon.com', pathname: `/dp/${asin}` }, URL,
  });
}
test('reads verified ASIN MAIN high resolution URL rather than thumbnail', () => {
  assert.equal(extract().sourceUrl, url);
});
test('falls back to the largest declared image, never invents an original URL', () => {
  const result = extract({ image: { 'data-a-dynamic-image': JSON.stringify({ 'https://m.media-amazon.com/images/I/small.jpg': [100,100], [url]: [1254,1254] }) } });
  assert.equal(result.sourceUrl, url);
});
test('invalid preferred MAIN URLs fall back to the verified MAIN src', () => {
  const src = 'https://m.media-amazon.com/images/I/61o8k673O+L._AC_SX679_.jpg';
  assert.equal(extract({ image: {
    'data-old-hires': 'https://untrusted.test/main.jpg',
    'data-a-dynamic-image': JSON.stringify({ 'https://untrusted.test/large.jpg': [1500,1500] }),
    src,
  } }).sourceUrl, src);
});
test('invalid high resolution URL falls back to largest trusted dynamic MAIN image', () => {
  assert.equal(extract({ image: { 'data-old-hires': 'https://evil.test/main.jpg',
    'data-a-dynamic-image': JSON.stringify({ 'https://evil.test/large.jpg': [2000,2000], [url]: [1254,1254] }),
    src: 'https://m.media-amazon.com/images/I/small.jpg',
  } }).sourceUrl, url);
});
test('refuses redirected variant and CAPTCHA instead of copying another image', () => {
  assert.equal(extract({pageAsin:'B000000001'}).errorCode, 'ASIN_MISMATCH');
  assert.equal(extract({challenge:true}).errorCode, 'AMAZON_CHALLENGE');
});
test('rejected MAIN image reports safe URL diagnostics without credentials or query secrets', () => {
  const result = extract({ image: { 'data-old-hires': 'https://user:password@images-na.ssl-images-amazon.com/images/I/main.jpg?token=secret#private' } });
  assert.equal(result.errorCode, 'INVALID_IMAGE_URL');
  assert.match(result.errorMessage, /data-old-hires/);
  assert.match(result.errorMessage, /images-na\.ssl-images-amazon\.com/);
  assert.match(result.errorMessage, /credentials=true/);
  assert.doesNotMatch(result.errorMessage, /user|password|token|secret|private/);
  assert.ok(result.errorMessage.length <= 300);
  const invalid = extract({ image: { src: 'not-a-url?token=secret' } });
  assert.match(invalid.errorMessage, /src.*parse=TypeError/);
  assert.doesNotMatch(invalid.errorMessage, /secret/);
});
test('download rejects untrusted host, oversized bytes, non-image response and redirects', async () => {
  await assert.rejects(images.downloadListingImage('https://evil.test/image.jpg'), /trusted/i);
  await assert.rejects(images.downloadListingImage(url, { fetchImpl: async () => new Response('html',{headers:{'content-type':'text/html'}}) }), /image/i);
  await assert.rejects(images.downloadListingImage(url, { maxBytes:3, fetchImpl: async () => new Response(new Uint8Array([255,216,255,224]),{headers:{'content-type':'image/jpeg'}}) }), /large/i);
  await assert.rejects(images.downloadListingImage(url, { fetchImpl: async () => ({ok:true,redirected:true}) }), /redirect/i);
});
test('download returns image bytes without sending Amazon cookies', async () => {
  const blob = await images.downloadListingImage(url, { fetchImpl: async (_url, options) => {
    assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    return new Response(new Uint8Array([255,216,255,224]),{headers:{'content-type':'image/jpeg'}});
  }});
  assert.equal(blob.type,'image/jpeg'); assert.equal(blob.size,4);
});
test('trusted CDN paths are opaque during MAIN extraction and download', async () => {
  for (const sourceUrl of [
    'https://m.media-amazon.com/images/W/BW_MEDIAX_AVIF_MEASUREMENT_1306696-T2/images/I/61GdTTezDrL._AC_SX679_.jpg',
    'https://m.media-amazon.com/future-layout/main-image',
  ]) {
    assert.equal(extract({ image: { src: sourceUrl } }).sourceUrl, sourceUrl);
    const blob = await images.downloadListingImage(sourceUrl, { fetchImpl: async (requested) => {
      assert.equal(requested, sourceUrl);
      return new Response(new Uint8Array([255,216,255,224]), { headers: { 'content-type': 'image/jpeg' } });
    } });
    assert.equal(blob.size, 4);
  }
});
test('CDN URL validation rejects protocol, credentials, ports and hostname lookalikes', async () => {
  for (const bad of ['http://m.media-amazon.com/a', 'https://user:pass@m.media-amazon.com/a', 'https://m.media-amazon.com:8443/a', 'https://m.media-amazon.com.evil.test/a', 'https://evil.test/m.media-amazon.com/a']) {
    assert.equal(extract({ image: { src: bad } }).errorCode, 'INVALID_IMAGE_URL');
    await assert.rejects(images.downloadListingImage(bad, { fetchImpl: () => { assert.fail('Must not fetch'); } }), /trusted/);
  }
});

function fixture({fatal=false, paused=false}={}) {
  let remaining = [{id:'item1',listingId:'listing1',asin,marketplaceCode:'US'},{id:'item2',listingId:'listing2',asin,marketplaceCode:'US'}];
  const results=[], removed=[], visited=[];
  const chromeApi={tabs:{create:async()=>({id:91}),update:async(id,input)=>{visited.push(input.url);},get:async()=>({status:'complete'}),remove:async id=>removed.push(id)},scripting:{executeScript:async()=>[{result:fatal?{errorCode:'AMAZON_CHALLENGE',errorMessage:'CAPTCHA'}:{asin,sourceUrl:url}}]}};
  const fetchImpl=async (target,options={})=>{
    if(target===url)return new Response(new Uint8Array([255,216,255,224]),{headers:{'content-type':'image/jpeg'}});
    if(target.endsWith('/items/query')) return Response.json({data:{jobId:'job',status:paused?'PAUSED':'RUNNING',items:remaining}});
    if(target.endsWith('/pause')){results.push('PAUSED'); return Response.json({data:{status:'PAUSED'}});}
    if(target.endsWith('/result')){assert.ok(options.body instanceof FormData);assert.equal(options.body.get('asin'),asin);assert.equal(options.body.get('leaseToken'),'lease'); results.push('UPLOADED');remaining=remaining.slice(1);return Response.json({data:{status:'SUCCEEDED'}});}
    throw new Error('Unexpected request '+target);
  };
  return {chromeApi,fetchImpl,results,removed,visited};
}
test('batch uploads and acknowledges each item and closes only its owned tab', async()=>{
  const f=fixture();const result=await images.runListingImageBatch({base:'https://be.test',token:'token',client:{clientId:'client'},command:{id:'cmd'},leaseToken:'lease',onProgress:async()=>{},...f});
  assert.equal(result.importedCount,2);assert.deepEqual(f.results,['UPLOADED','UPLOADED']);assert.deepEqual(f.removed,[91]);assert.equal(f.visited.length,2);
});
test('paused parent performs no Amazon work',async()=>{
  const f=fixture({paused:true});await images.runListingImageBatch({base:'https://be.test',token:'token',client:{clientId:'client'},command:{id:'cmd'},leaseToken:'lease',onProgress:async()=>{},...f});
  assert.equal(f.visited.length,0);assert.equal(f.results.length,0);
});
test('challenge pauses parent without uploading or failing the remaining listing',async()=>{
  const f=fixture({fatal:true});await assert.rejects(images.runListingImageBatch({base:'https://be.test',token:'token',client:{clientId:'client'},command:{id:'cmd'},leaseToken:'lease',onProgress:async()=>{},...f}),/CAPTCHA/);
  assert.deepEqual(f.results,['PAUSED']);assert.deepEqual(f.removed,[91]);
});
test('lost command lease stops before browsing or uploading',async()=>{
  const f=fixture();await assert.rejects(images.runListingImageBatch({base:'https://be.test',token:'token',client:{clientId:'client'},command:{id:'cmd'},leaseToken:'lease',onProgress:async()=>{throw new Error('Lease lost');},...f}),/Lease lost/);
  assert.equal(f.visited.length,0);assert.equal(f.results.length,0);
});

test('closing the worker tab pauses without failing all remaining listings',async()=>{
  const f=fixture();
  f.chromeApi.tabs.get=async()=>{throw new Error('No tab with id: 91');};
  await assert.rejects(images.runListingImageBatch({base:'https://be.test',token:'token',client:{clientId:'client'},command:{id:'cmd'},leaseToken:'lease',onProgress:async()=>{},...f}),/tab.*unavailable/i);
  assert.deepEqual(f.results,['PAUSED']);
  assert.equal(f.visited.length,1);
});
