
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

// MV3 background service worker
const AI_HOST = 'http://127.0.0.1:48159';
const BADGE_BG = '#ff7fc8';

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

      if (msg?.type === 'FETCH_AI_ENHANCE') {
        const { sourceUrl, dataUrl, scale, quality } = msg || {};
        const qs = new URLSearchParams();
        if (typeof scale === 'number') qs.set('scale', String(scale));
        if (quality) qs.set('quality', String(quality));
        if (sourceUrl) qs.set('url', sourceUrl);
        const url = `${AI_HOST}/enhance?${qs.toString()}`;

        let resp;
        if (dataUrl && !sourceUrl) {
          const { bytes, contentType } = dataUrlToBytes(dataUrl);
          resp = await fetch(url, { method: 'POST', body: bytes, headers: { 'Content-Type': contentType } });
        } else {
          resp = await fetch(url, { cache: 'no-store' });
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const model = resp.headers.get('X-MU-Model') || '';
        const hostError = resp.headers.get('X-MU-Host-Error') || '';
        const blob = await resp.blob();
        const outUrl = await blobToDataURL(blob);
        sendResponse({ ok: true, dataUrl: outUrl, model, hostError });
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
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType };
}
