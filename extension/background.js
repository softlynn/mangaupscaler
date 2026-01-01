
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

  // Seed telemetry defaults only if user hasn't set them yet.
  try{
    const all = await chrome.storage.sync.get(null);
    const patch = {};
    if (!Object.prototype.hasOwnProperty.call(all, 'telemetryEnabled')) patch.telemetryEnabled = TELEMETRY_DEFAULT_ENABLED;
    if (!Object.prototype.hasOwnProperty.call(all, 'telemetryUploadUrl')) patch.telemetryUploadUrl = TELEMETRY_DEFAULT_UPLOAD_URL;
    if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  } catch {
    // ignore
  }
});

chrome.runtime.onSuspend.addListener(() => {
  // When Chrome closes, stop the tray + host so it doesn't linger.
  stopTray().catch(()=>{});
  stopNativeHost('suspend').catch(()=>{});
});

// MV3 background service worker
const AI_HOST = 'http://127.0.0.1:48159';
const BADGE_BG = '#ff7fc8';
const NATIVE_HOST = 'com.softlynn.manga_upscaler';
const TELEMETRY_DEFAULT_ENABLED = true;
const TELEMETRY_DEFAULT_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbzva5kasl0U0QgZc8tAFzcbERqdL98S8rjRdjY8by4C8yINApPSRH3qZaU3OReknQz7/exec';

let hostOkUntil = 0;
const AI_STREAM_CHUNK_SIZE = 256 * 1024; // 256KB
const aiStreamStore = new Map(); // id -> { buffer: ArrayBuffer, byteLength, chunkSize, chunkCount, contentType, model, hostError, elapsedMs, createdAt }
let tabScanTimer = null;
let lastTrayState = null; // 'running' | 'stopped' | null
let telemetryCfg = null; // { enabled: boolean, uploadUrl: string }
let telemetryClientId = null;
let settingsCache = { enabled: true, whitelist: {} };
let settingsCacheLoaded = false;
let settingsCachePromise = null;
let ensureHostPromise = null;

const mangaTabIds = new Set(); // tabId set for allowed manga sites (http/https only)

function newStreamId(){
  try{
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

async function ensureSettingsCache(){
  if (settingsCacheLoaded) return settingsCache;
  if (settingsCachePromise) return settingsCachePromise;
  settingsCachePromise = (async ()=>{
    try{
      const s = await chrome.storage.sync.get({ enabled: true, whitelist: {} });
      settingsCache = { enabled: !!s.enabled, whitelist: s.whitelist || {} };
    } catch {
      // keep defaults
    } finally {
      settingsCacheLoaded = true;
      settingsCachePromise = null;
    }
    return settingsCache;
  })();
  return settingsCachePromise;
}

async function loadTelemetryCfg(){
  if (telemetryCfg) return telemetryCfg;
  try{
    const s = await chrome.storage.sync.get({ telemetryEnabled: TELEMETRY_DEFAULT_ENABLED, telemetryUploadUrl: TELEMETRY_DEFAULT_UPLOAD_URL });
    telemetryCfg = {
      enabled: !!s.telemetryEnabled,
      uploadUrl: String(s.telemetryUploadUrl || '').trim()
    };
    return telemetryCfg;
  } catch {
    telemetryCfg = { enabled: TELEMETRY_DEFAULT_ENABLED, uploadUrl: TELEMETRY_DEFAULT_UPLOAD_URL };
    return telemetryCfg;
  }
}

async function getTelemetryClientId(){
  if (telemetryClientId) return telemetryClientId;
  try{
    const s = await chrome.storage.local.get({ telemetryClientId: '' });
    let id = String(s.telemetryClientId || '').trim();
    if (!id) {
      id = newStreamId();
      await chrome.storage.local.set({ telemetryClientId: id });
    }
    telemetryClientId = id;
    return id;
  } catch {
    telemetryClientId = newStreamId();
    return telemetryClientId;
  }
}

function storeAiStream({ buffer, contentType, model, hostError, elapsedMs }){
  const id = newStreamId();
  const byteLength = buffer?.byteLength || 0;
  const chunkSize = AI_STREAM_CHUNK_SIZE;
  const chunkCount = byteLength ? Math.ceil(byteLength / chunkSize) : 0;
  const entry = {
    buffer,
    byteLength,
    chunkSize,
    chunkCount,
    contentType: contentType || 'application/octet-stream',
    model: model || '',
    hostError: hostError || '',
    elapsedMs: Number(elapsedMs || 0),
    createdAt: Date.now()
  };
  aiStreamStore.set(id, entry);
  // Keep for a while; host inference can be slow and the service worker can be busy.
  setTimeout(() => aiStreamStore.delete(id), 5 * 60_000);
  return { id, chunkCount };
}

function ensureContextMenu() {
  try{
    chrome.contextMenus.removeAll(()=>{
      chrome.contextMenus.create({
        id: 'mu-enhance-image',
        title: 'Manga Upscaler: Enhance this image',
        contexts: ['image']
      });
    });
  } catch {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
  maybeAutoStartTray('install').catch(()=>{});
});
chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
  maybeAutoStartTray('startup').catch(()=>{});
});

let mangaTabsNeedFullRescan = true;
let mangaTabsRescanPromise = null;

async function rescanMangaTabs(){
  if (mangaTabsRescanPromise) return mangaTabsRescanPromise;
  mangaTabsRescanPromise = (async ()=>{
    const s = await ensureSettingsCache();
    mangaTabIds.clear();
    if (!s?.enabled) return;
    const tabs = await chrome.tabs.query({});
    for (const t of tabs){
      const tabId = t?.id;
      if (typeof tabId !== 'number') continue;
      const host = extractHost(t?.url);
      if (!host) continue;
      if (hostAllowed(host, s.whitelist || {})) mangaTabIds.add(tabId);
    }
  })().finally(()=>{ mangaTabsRescanPromise = null; });
  return mangaTabsRescanPromise;
}

async function updateMangaTabFromUrl(tabId, url){
  if (typeof tabId !== 'number') return;
  const s = await ensureSettingsCache();
  if (!s?.enabled) { mangaTabIds.delete(tabId); return; }
  const host = extractHost(url);
  if (!host) { mangaTabIds.delete(tabId); return; }
  if (hostAllowed(host, s.whitelist || {})) mangaTabIds.add(tabId);
  else mangaTabIds.delete(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try{
    if (changeInfo?.url) {
      updateMangaTabFromUrl(tabId, changeInfo.url).then(()=>scheduleTrayReconcile('tabs_updated')).catch(()=>{});
      return;
    }
    if (changeInfo?.status === 'complete' && tab?.url) {
      updateMangaTabFromUrl(tabId, tab.url).then(()=>scheduleTrayReconcile('tabs_updated')).catch(()=>{});
      return;
    }
  } catch {}
});
chrome.tabs.onRemoved.addListener((tabId) => {
  try { mangaTabIds.delete(tabId); } catch {}
  scheduleTrayReconcile('tabs_removed');
});
chrome.tabs.onCreated.addListener((tab) => {
  try{
    if (typeof tab?.id === 'number' && tab?.url) {
      updateMangaTabFromUrl(tab.id, tab.url).then(()=>scheduleTrayReconcile('tabs_created')).catch(()=>{});
    }
  } catch {}
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  try{
    if (Object.prototype.hasOwnProperty.call(changes, 'enabled')) {
      settingsCache.enabled = !!changes.enabled?.newValue;
      settingsCacheLoaded = true;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'whitelist')) {
      settingsCache.whitelist = changes.whitelist?.newValue || {};
      settingsCacheLoaded = true;
    }
  } catch {
    // ignore
  }
  if (changes.enabled || changes.whitelist) {
    mangaTabsNeedFullRescan = true;
    scheduleTrayReconcile('settings_changed');
  }
  if (changes.telemetryEnabled || changes.telemetryUploadUrl) telemetryCfg = null;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'mu-enhance-image') return;
  const url = info.srcUrl || '';
  if (!tab?.id || !url) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ENHANCE_IMAGE_URL', url }).catch(()=>{});
});

async function delay(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractHost(url){
  const s = String(url || '');
  if (!s.startsWith('http://') && !s.startsWith('https://')) return '';
  try { return new URL(s).hostname || ''; } catch { return ''; }
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

function hostAllowed(host, whitelist){
  if (!host) return false;
  const wh = whitelist || {};
  const any = Object.keys(wh).length > 0;
  if (!any) return (host === 'comix.to' || host === 'weebcentral.com' || host.endsWith('.weebcentral.com'));
  return !!wh[host];
}

async function countMangaTabs(){
  try{
    const s = await ensureSettingsCache();
    if (!s?.enabled) return 0;
    if (mangaTabsNeedFullRescan) {
      mangaTabsNeedFullRescan = false;
      await rescanMangaTabs();
    }
    return mangaTabIds.size;
  } catch {
    return 0;
  }
}

async function reconcileTray(reason){
  const n = await countMangaTabs();
  if (n <= 0) {
    if (lastTrayState !== 'stopped') {
      await stopNativeHost(reason || 'no_manga_tabs');
      await stopTray();
      lastTrayState = 'stopped';
    }
    return;
  }
  if (lastTrayState !== 'running') {
    await startTray();
    await ensureHostRunning(reason || 'manga_tabs');
    lastTrayState = 'running';
  } else {
    await ensureHostRunning(reason || 'manga_tabs');
  }
}

function scheduleTrayReconcile(reason){
  try{
    if (tabScanTimer) clearTimeout(tabScanTimer);
    tabScanTimer = setTimeout(() => reconcileTray(reason).catch(()=>{}), 500);
  } catch {}
}

async function maybeAutoStartTray(reason){
  try{
    const s = await ensureSettingsCache();
    if (!s?.enabled) return false;
    mangaTabsNeedFullRescan = true;
    scheduleTrayReconcile(reason || 'auto');
    return true;
  } catch {
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
  if (ensureHostPromise) return ensureHostPromise;
  ensureHostPromise = (async ()=>{
    try{
      await startNativeHost(reason);
      for (let i = 0; i < 10; i++) {
        if (await pingHost()) return true;
        await delay(400);
      }
      return false;
    } finally {
      ensureHostPromise = null;
    }
  })();
  return ensureHostPromise;
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
      if (msg?.type === 'HOST_STATUS') {
        const hostOk = await pingHost(true);
        let telemetryRecentOk = false;
        if (hostOk) {
          try{
            const r = await fetch(`${AI_HOST}/telemetry/recent`, { cache: 'no-store' });
            telemetryRecentOk = r.ok;
          } catch {}
        }
        sendResponse({ ok: true, hostOk, telemetryRecentOk });
        return;
      }

      if (msg?.type === 'TELEMETRY_TEST') {
        const cfg = await loadTelemetryCfg();
        if (!cfg.enabled) { sendResponse({ ok: true, dropped: true }); return; }
        const hostOk = await pingHost(true);
        let telemetryRecentOk = false;
        if (hostOk) {
          try{
            const r = await fetch(`${AI_HOST}/telemetry/recent`, { cache: 'no-store' });
            telemetryRecentOk = r.ok;
          } catch {}
        }
        // reuse the telemetry sending path
        const payload = {
          v: 1,
          ts: new Date().toISOString(),
          type: 'test',
          clientId: await getTelemetryClientId(),
          site: { host: '', pathSig: '', profile: '' },
          ext: { version: '' },
          settings: {},
          data: { source: 'telemetry_test' }
        };

        let localOk = null;
        let remoteOk = null;
        if (hostOk) {
          try{
            const r = await fetch(`${AI_HOST}/telemetry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            localOk = r.ok;
          } catch { localOk = false; }
        } else {
          localOk = false;
        }
        if (cfg.uploadUrl && /^https?:\/\//i.test(cfg.uploadUrl)) {
          try{
            const r = await fetch(cfg.uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              referrerPolicy: 'no-referrer',
              body: JSON.stringify(payload)
            });
            remoteOk = r.ok;
          } catch { remoteOk = false; }
        }
        sendResponse({ ok: true, hostOk, telemetryRecentOk, localOk, remoteOk, uploadUrl: cfg.uploadUrl || '' });
        return;
      }

      if (msg?.type === 'UPDATE_ALL') {
        // Updates are performed by the native tray host in headless mode.
        // Note: unpacked extensions can be updated on disk, but Chrome still needs a reload.
        try{
          const extId = chrome.runtime.id;
          const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'update_all', extensionId: extId });
          const ok = !!resp?.ok;
          sendResponse(resp || { ok: false, error: 'No response' });
          if (ok && resp?.extension?.applied) {
            // Give filesystem writes a moment to flush, then reload this extension.
            setTimeout(() => { try { chrome.runtime.reload(); } catch {} }, 800);
          }
        } catch (e) {
          const msg = String(e?.message || e || '');
          sendResponse({
            ok: false,
            error: msg || 'Update failed',
            hint: 'Install the latest host from the alpha release once, then retry.'
          });
        }
        return;
      }

      if (msg?.type === 'TELEMETRY_EVENT') {
        const cfg = await loadTelemetryCfg();
        if (!cfg.enabled) { sendResponse({ ok: true, dropped: true }); return; }

        const payload = { ...(msg.payload || {}) };
        payload.clientId = await getTelemetryClientId();

        const tasks = [];
        let localOk = null;
        let remoteOk = null;

        // Local host telemetry (viewable at /telemetry/recent). Never start the host just for telemetry.
        if (await pingHost()) {
          tasks.push((async () => {
            try{
              const resp = await fetch(`${AI_HOST}/telemetry`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
              localOk = resp.ok;
            } catch {
              localOk = false;
            }
          })());
        } else {
          localOk = false;
        }

        // Optional remote upload (user-configured). Server must accept cross-origin POSTs from extensions.
        if (cfg.uploadUrl && /^https?:\/\//i.test(cfg.uploadUrl)) {
          tasks.push((async () => {
            try{
              const resp = await fetch(cfg.uploadUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                referrerPolicy: 'no-referrer',
                body: JSON.stringify(payload)
              });
              remoteOk = resp.ok;
            } catch {
              remoteOk = false;
            }
          })());
        }

        await Promise.allSettled(tasks);
        sendResponse({ ok: true, localOk, remoteOk });
        return;
      }

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
        await startTray();
        const ok = await ensureHostRunning(msg?.reason || 'manual');
        sendResponse({ ok });
        return;
      }

      if (msg?.type === 'HOST_STOP') {
        await stopNativeHost(msg?.reason || 'manual');
        const ok = await stopTray();
        sendResponse({ ok });
        return;
      }

      if (msg?.type === 'TRAY_START') {
        const ok = await startTray();
        await ensureHostRunning(msg?.reason || 'tray_start');
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
        const contentType = (resp.headers.get('content-type') || blob.type || 'image/png').split(';')[0];
        const elapsedMs = Date.now() - t0;
        // Large payloads sent via sendMessage can be flaky or truncated. Stream in chunks instead.
        const stream = storeAiStream({ buffer, contentType, model, hostError, elapsedMs });
        sendResponse({
          ok: true,
          streamId: stream.id,
          chunkCount: stream.chunkCount,
          byteLength: buffer.byteLength,
          contentType,
          model,
          hostError,
          elapsedMs
        });
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

      if (msg?.type === 'AI_STREAM_CHUNK') {
        const { streamId, index } = msg || {};
        const entry = aiStreamStore.get(String(streamId || ''));
        if (!entry) throw new Error('Unknown stream');
        const i = Number(index || 0);
        if (!Number.isFinite(i) || i < 0) throw new Error('Invalid chunk index');
        if (i >= entry.chunkCount) throw new Error('Chunk not found');
        const offset = i * entry.chunkSize;
        const len = Math.max(0, Math.min(entry.chunkSize, entry.byteLength - offset));
        if (!len) throw new Error('Chunk not found');
        // TypedArray clones more reliably than raw ArrayBuffer in some Chrome builds.
        const u8 = new Uint8Array(entry.buffer, offset, len);
        sendResponse({ ok: true, chunk: u8, index: i, last: (i === entry.chunkCount - 1) });
        return;
      }

      if (msg?.type === 'AI_STREAM_CHUNK_B64') {
        const { streamId, index } = msg || {};
        const entry = aiStreamStore.get(String(streamId || ''));
        if (!entry) throw new Error('Unknown stream');
        const i = Number(index || 0);
        if (!Number.isFinite(i) || i < 0) throw new Error('Invalid chunk index');
        if (i >= entry.chunkCount) throw new Error('Chunk not found');
        const offset = i * entry.chunkSize;
        const len = Math.max(0, Math.min(entry.chunkSize, entry.byteLength - offset));
        if (!len) throw new Error('Chunk not found');
        const u8 = new Uint8Array(entry.buffer, offset, len);
        const b64 = uint8ToBase64(u8);
        sendResponse({ ok: true, b64, index: i, last: (i === entry.chunkCount - 1) });
        return;
      }

      if (msg?.type === 'AI_STREAM_DELETE') {
        const { streamId } = msg || {};
        aiStreamStore.delete(String(streamId || ''));
        sendResponse({ ok: true });
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

function uint8ToBase64(bytes){
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer){
  return uint8ToBase64(new Uint8Array(buffer));
}
