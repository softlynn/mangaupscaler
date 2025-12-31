
chrome.runtime.onInstalled.addListener(async ()=>{
  // Seed a sensible default whitelist (manga readers) if user has none yet
  const defaults = {
    'comix.to': true,
    'weebcentral.com': true,
    'mangadex.org': true,
    'mangareader.to': true,
    'manganato.com': true,
    'mangakakalot.com': true,
    'manga4life.com': true,
    'manga4life.net': true,
    'mangasee123.com': true,
    'bato.to': true,
    'readm.org': true,
    'mangago.me': true,
    'asuracomic.net': true,
    'reaperscans.com': true,
    'flamecomics.com': true,
    'zeroscans.com': true,
    'toongod.org': true,
    'webtoons.com': false
  };

  const data = await chrome.storage.sync.get(['whitelist']);
  const wl = data.whitelist || {};
  if (Object.keys(wl).length === 0){
    await chrome.storage.sync.set({ whitelist: defaults });
  }
});

chrome.runtime.onSuspend.addListener(() => {
  stopNativeHost('suspend');
});

// MV3 background service worker
const AI_HOST = 'http://127.0.0.1:48159';
const BADGE_BG = '#ff7fc8';
const NATIVE_HOST = 'com.softlynn.manga_upscaler';

let hostOkUntil = 0;

async function delay(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pingHost(force=false){
  if (!force && Date.now() < hostOkUntil) return true;
  try{
    const resp = await fetch(`${AI_HOST}/health`, { cache: 'no-store' });
    const ok = resp.ok;
    if (ok) hostOkUntil = Date.now() + 2000;
    return ok;
  }catch{
    return false;
  }
}

async function startNativeHost(reason){
  try{
    const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'start', reason });
    return !!resp?.ok;
  }catch{
    return false;
  }
}

async function startTray(){
  try{
    const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'tray_start' });
    return !!resp?.ok;
  }catch{
    return false;
  }
}

async function stopTray(){
  try{
    const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'tray_stop' });
    return !!resp?.ok;
  }catch{
    return false;
  }
}

async function stopNativeHost(reason){
  try{
    await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'stop', reason });
  }catch{
    // ignore
  }
  try{
    await fetch(`${AI_HOST}/shutdown`, { method: 'POST' });
  }catch{
    // ignore
  }
  hostOkUntil = 0;
  return !(await pingHost());
}

async function ensureHostRunning(reason){
  if (await pingHost()) return true;
  await startNativeHost(reason);
  for (let i = 0; i < 10; i++) {
    if (await pingHost()) return true;
    await delay(400);
  }
  return false;
}

function isCommError(err){
  const msg = String(err?.message || err || '');
  // fetch() network failures in extensions typically show up as TypeError: Failed to fetch.
  return (
    err instanceof TypeError ||
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ERR_CONNECTION') ||
    msg.includes('ERR_FAILED')
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'FETCH_IMAGE_DATAURL') {
        const { url } = msg;
        if (!url) throw new Error('No url');
        // Try a normal fetch first (extension has <all_urls> host permission).
        // Some CDNs dislike missing referrer; we cannot always set it, but we can at least set credentials to omit.
        const resp = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const dataUrl = await blobToDataURL(blob);
        sendResponse({ ok: true, dataUrl });
        return;
      }

      if (msg?.type === 'HOST_START') {
        const ok = await ensureHostRunning(msg?.reason || 'manual');
        sendResponse({ ok });
        return;
      }

      if (msg?.type === 'HOST_STOP') {
        const ok = await stopNativeHost(msg?.reason || 'manual');
        sendResponse({ ok });
        return;
      }

      if (msg?.type === 'TRAY_START') {
        const ok = await startTray();
        sendResponse({ ok });
        return;
      }

      if (msg?.type === 'TRAY_STOP') {
        await stopNativeHost(msg?.reason || 'tray_stop');
        const ok = await stopTray();
        sendResponse({ ok });
        return;
      }

      if (msg?.type === 'FETCH_AI_ENHANCE') {
        const { sourceUrl, dataUrl, scale, quality, format } = msg || {};
        const t0 = Date.now();
        if (!await ensureHostRunning('enhance')) throw new Error('AI host not running');
        const qs = new URLSearchParams();
        if (typeof scale === 'number') qs.set('scale', String(scale));
        if (quality) qs.set('quality', String(quality));
        if (format) qs.set('format', String(format));
        if (sourceUrl) qs.set('url', sourceUrl);
        const url = `${AI_HOST}/enhance?${qs.toString()}`;

        const doFetch = async () => {
          if (dataUrl && !sourceUrl) {
            const { bytes, contentType } = dataUrlToBytes(dataUrl);
            return await fetch(url, { method: 'POST', body: bytes, headers: { 'Content-Type': contentType } });
          }
          return await fetch(url, { cache: 'no-store' });
        };

        let resp;
        try{
          resp = await doFetch();
        } catch (e) {
          // If the host process died or the local server is down, try restarting once.
          if (isCommError(e)) {
            await stopNativeHost('comm_error_retry');
            await ensureHostRunning('comm_error_retry');
            resp = await doFetch();
          } else {
            throw e;
          }
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const model = resp.headers.get('X-MU-Model') || '';
        const hostError = resp.headers.get('X-MU-Host-Error') || '';
        const blob = await resp.blob();
        const buffer = await blob.arrayBuffer();
        // Some Chrome builds/extensions have flaky ArrayBuffer transfer over sendMessage for large payloads.
        // Also include base64 as a robust fallback transport.
        const b64 = arrayBufferToBase64(buffer);
        const contentType = (resp.headers.get('content-type') || blob.type || 'image/png').split(';')[0];
        const elapsedMs = Date.now() - t0;
        sendResponse({ ok: true, buffer, b64, byteLength: buffer.byteLength, contentType, model, hostError, elapsedMs });
        return;
      }

      if (msg?.type === 'AI_PRELOAD') {
        const { sourceUrl, scale, quality, format } = msg || {};
        const t0 = Date.now();
        if (!sourceUrl) throw new Error('Missing sourceUrl');
        if (!await ensureHostRunning('preload')) throw new Error('AI host not running');
        const qs = new URLSearchParams();
        if (typeof scale === 'number') qs.set('scale', String(scale));
        if (quality) qs.set('quality', String(quality));
        if (format) qs.set('format', String(format));
        qs.set('url', sourceUrl);
        const url = `${AI_HOST}/enhance?${qs.toString()}`;
        let resp;
        try{
          resp = await fetch(url, { cache: 'no-store' });
        } catch (e) {
          if (isCommError(e)) {
            await stopNativeHost('comm_error_retry');
            await ensureHostRunning('comm_error_retry');
            resp = await fetch(url, { cache: 'no-store' });
          } else {
            throw e;
          }
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const model = resp.headers.get('X-MU-Model') || '';
        const hostError = resp.headers.get('X-MU-Host-Error') || '';
        // Drain body without transferring it across sendMessage.
        try{
          if (resp.body && resp.body.getReader) {
            const reader = resp.body.getReader();
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } else {
            await resp.arrayBuffer();
          }
        } catch {
          // ignore drain errors
        }
        const elapsedMs = Date.now() - t0;
        sendResponse({ ok: true, model, hostError, elapsedMs });
        return;
      }

      if (msg?.type === 'AI_ENHANCE_URL') {
        const { sourceUrl, scale, quality, format } = msg || {};
        if (!sourceUrl) throw new Error('Missing sourceUrl');
        if (!await ensureHostRunning('enhance_url')) throw new Error('AI host not running');
        const qs = new URLSearchParams();
        if (typeof scale === 'number') qs.set('scale', String(scale));
        if (quality) qs.set('quality', String(quality));
        if (format) qs.set('format', String(format));
        qs.set('url', sourceUrl);
        sendResponse({ ok: true, url: `${AI_HOST}/enhance?${qs.toString()}` });
        return;
      }

      if (msg?.type === 'HOST_CONFIG') {
        if (!await ensureHostRunning('config')) throw new Error('AI host not running');
        const { cacheMaxGb, cacheMaxAgeDays, allowDat2, idleShutdownMinutes } = msg || {};
        const resp = await fetch(`${AI_HOST}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cache_max_gb: cacheMaxGb,
            cache_max_age_days: cacheMaxAgeDays,
            allow_dat2: allowDat2,
            idle_shutdown_minutes: idleShutdownMinutes
          })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'HOST_CLEAR_CACHE') {
        if (!await ensureHostRunning('cache')) throw new Error('AI host not running');
        const resp = await fetch(`${AI_HOST}/cache/clear`, { method: 'POST' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'HOST_DOWNLOAD_MODELS') {
        if (!await ensureHostRunning('download')) throw new Error('AI host not running');
        const allowDat2 = !!msg.allowDat2;
        const resp = await fetch(`${AI_HOST}/models/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allow_dat2: allowDat2 })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'BADGE_UP') {
        const tabId = sender?.tab?.id ?? msg.tabId;
        if (typeof tabId === 'number') {
          await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG });
          await chrome.action.setBadgeText({ tabId, text: 'UP' });
          setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(()=>{}), 1600);
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep sendResponse alive
});

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!match) throw new Error('Invalid data URL');
  const contentType = match[1];
  const b64 = match[2];
  if (!b64) throw new Error('Empty data URL');
  const bin = atob(b64);
  if (!bin.length) throw new Error('Empty data URL');
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType };
}

function arrayBufferToBase64(buffer){
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
