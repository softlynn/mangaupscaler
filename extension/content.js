// Manga Upscaler content script (v1.1.0)
// Enhances the currently visible manga panel (largest visible image) by:
// 1) fetching the image data safely (via background to avoid CORS taint)
// 2) sending it to the local AI host (MangaJaNai / IllustrationJaNai)
// 3) rendering the result with CSP-safe fallbacks (blob/data/canvas overlay)
// 4) sparkle + toast

const AI_HOST = 'http://127.0.0.1:48159';

const DEFAULTS = {
  enabled: true,
  autoPanel: true,
  scale: 3,
  preUpscaleCount: 3,          // 0..5
  aiQuality: 'balanced',       // fast/balanced/best
  whitelist: {},               // {hostname:true}
  showToast: true
};

let settings = { ...DEFAULTS };
// Canvas roundRect polyfill
if (CanvasRenderingContext2D && !CanvasRenderingContext2D.prototype.roundRect){
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
    r = Math.min(r, w/2, h/2);
    this.beginPath();
    this.moveTo(x+r, y);
    this.arcTo(x+w, y, x+w, y+h, r);
    this.arcTo(x+w, y+h, x, y+h, r);
    this.arcTo(x, y+h, x, y, r);
    this.arcTo(x, y, x+w, y, r);
    this.closePath();
    return this;
  };
}

let busy = false;
let observerStarted = false;
let aiHostDownUntil = 0;
let aiHostFailCount = 0;
let aiBurstCount = 0;
let aiBurstLastAt = 0;
let cooldownRetryTimer = null;
let cooldownRetryPreload = false;
let cooldownNotifiedUntil = 0;
let toastEl = null;
let toastTimer = null;
let io = null;
let visibleScores = new Map(); // Map<img, intersectionArea>
let lastHostStartAt = 0;
let canvasOverlays = new WeakMap(); // WeakMap<img, { wrapper: HTMLElement, canvas: HTMLCanvasElement }>
let preloadStatus = { target: 0, preloaded: 0, prefetched: 0, updatedAt: 0, currentUrl: '' };
let pagePrefetch = new Map(); // url -> untilMs
let enhancedPreloadCache = new Map(); // key -> { blob, contentType, model, byteLength, createdAt, lastUsedAt }
let enhancedPreloadTotalBytes = 0;

const ENHANCED_PRELOAD_TTL_MS = 2 * 60 * 1000;
const ENHANCED_PRELOAD_MAX_ENTRIES = 6;
const ENHANCED_PRELOAD_MAX_BYTES = 140 * 1024 * 1024; // ~140MB

// ---------- Settings ----------
async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s, whitelist: s.whitelist || {} };
}

function maybeStartHost(reason){
  if (!settings.enabled) return;
  if (!hostAllowed()) return;
  const now = Date.now();
  if (now - lastHostStartAt < 8000) return;
  lastHostStartAt = now;
  chrome.runtime.sendMessage({ type: 'HOST_START', reason: reason || 'auto' }).catch(()=>{});
}

function maybeStopHost(reason){
  chrome.runtime.sendMessage({ type: 'HOST_STOP', reason: reason || 'auto' }).catch(()=>{});
}

function hostAllowed() {
  try {
    const host = location.hostname;
    // If whitelist has at least one entry, only run on whitelisted hosts.
    const wh = settings.whitelist || {};
    const any = Object.keys(wh).length > 0;
    if (!any) return (host === 'comix.to' || host === 'weebcentral.com' || host.endsWith('.weebcentral.com'));
    return !!wh[host];
  } catch {
    return false;
  }
}

// ---------- Helpers ----------
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function log(...a){ console.log('[MangaUpscaler]', ...a); }

function isHttpUrl(url){
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

function resolveUrlMaybe(url){
  try{
    return new URL(String(url), location.href).href;
  } catch {
    return String(url || '');
  }
}

function isEmptyBase64DataUrl(url){
  return typeof url === 'string' && /^data:[^;]+;base64,$/.test(url.trim());
}

function parseSrcsetUrls(srcset){
  if (!srcset) return [];
  try{
    return String(srcset)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => p.split(/\s+/)[0])
      .map(u => resolveUrlMaybe(u))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getBestImageUrl(imgEl){
  if (!imgEl) return '';
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (!u) return;
    const v = resolveUrlMaybe(u);
    if (!v) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  add(imgEl.currentSrc);
  add(imgEl.src);

  // Common lazy-load attributes.
  const attrs = [
    'data-src',
    'data-original',
    'data-lazy-src',
    'data-url',
    'data-img',
    'data-image',
    'data-full',
    'data-zoom-image',
    'data-srcset'
  ];
  for (const a of attrs){
    try{ add(imgEl.getAttribute(a)); }catch{}
  }

  // Try srcset (some sites keep the real URL there even when src is a placeholder data:).
  try{
    const srcset = imgEl.getAttribute('srcset') || '';
    for (const u of parseSrcsetUrls(srcset)) add(u);
  }catch{}

  // Prefer real network URLs.
  const http = out.find(isHttpUrl);
  if (http) return http;
  const blob = out.find(u => typeof u === 'string' && u.startsWith('blob:'));
  if (blob) return blob;
  const data = out.find(u => typeof u === 'string' && u.startsWith('data:') && !isEmptyBase64DataUrl(u));
  if (data) return data;
  return out[0] || '';
}

function clearCanvasOverlay(imgEl){
  try{
    const info = canvasOverlays.get(imgEl);
    if (!info) return;
    const { canvas, wrapper } = info;
    try { canvas.remove(); } catch {}
    try { wrapper.dataset.muCanvasWrapper = ''; } catch {}
    canvasOverlays.delete(imgEl);
    imgEl.style.opacity = '';
    imgEl.style.position = '';
    imgEl.style.left = '';
    imgEl.style.top = '';
    imgEl.style.width = imgEl.style.width || '';
    imgEl.style.height = imgEl.style.height || '';
    imgEl.style.objectFit = imgEl.style.objectFit || '';
  } catch {}
}

function ensureCanvasWrapper(imgEl){
  // Wrap the <img> so we can overlay a <canvas> without breaking layout.
  const parent = imgEl.parentElement;
  if (!parent) return null;

  if (parent.dataset && parent.dataset.muCanvasWrapper === '1') {
    return parent;
  }

  const wrapper = document.createElement('span');
  wrapper.dataset.muCanvasWrapper = '1';
  // Preserve layout: wrapper acts like the original img.
  const cs = getComputedStyle(imgEl);
  const rect = imgEl.getBoundingClientRect();
  wrapper.style.display = (cs.display === 'block' || cs.display === 'flex') ? 'block' : 'inline-block';
  wrapper.style.position = 'relative';
  wrapper.style.verticalAlign = cs.verticalAlign || 'baseline';
  wrapper.style.width = (cs.width && cs.width !== 'auto') ? cs.width : `${Math.max(1, Math.round(rect.width))}px`;
  wrapper.style.height = (cs.height && cs.height !== 'auto') ? cs.height : `${Math.max(1, Math.round(rect.height))}px`;
  wrapper.style.maxWidth = cs.maxWidth || '';
  wrapper.style.maxHeight = cs.maxHeight || '';

  parent.insertBefore(wrapper, imgEl);
  wrapper.appendChild(imgEl);
  return wrapper;
}

async function renderBlobOverImage(imgEl, blob){
  if (!blob || !blob.size) throw new Error('AI returned empty image');

  const wrapper = ensureCanvasWrapper(imgEl);
  if (!wrapper) throw new Error('Cannot overlay canvas');

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position:absolute; left:0; top:0; width:100%; height:100%;
    pointer-events:none; image-rendering:auto;
  `;

  const bmp = await decodeBlobToBitmap(blob);

  const bw = bmp.width || bmp.naturalWidth || 1;
  const bh = bmp.height || bmp.naturalHeight || 1;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(bw * dpr));
  canvas.height = Math.max(1, Math.round(bh * dpr));

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, bw, bh);

  // Hide original without removing it (avoids breaking site scripts).
  imgEl.style.position = 'absolute';
  imgEl.style.left = '0';
  imgEl.style.top = '0';
  imgEl.style.width = '100%';
  imgEl.style.height = '100%';
  imgEl.style.objectFit = 'contain';
  imgEl.style.opacity = '0';

  // Replace any existing overlay.
  clearCanvasOverlay(imgEl);
  wrapper.appendChild(canvas);
  canvasOverlays.set(imgEl, { wrapper, canvas });
}

function waitForImageLoad(imgEl, timeoutMs=15000){
  return new Promise((resolve, reject) => {
    if (!imgEl) return reject(new Error('Missing img'));

    let done = false;
    const finishOk = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(true);
    };
    const finishErr = (e) => {
      if (done) return;
      done = true;
      cleanup();
      const rawSrc = String(imgEl.currentSrc || imgEl.src || '');
      const src =
        rawSrc.startsWith('data:') ? 'data:…' :
        rawSrc.startsWith('blob:') ? rawSrc.slice(0, 120) :
        rawSrc.slice(0, 240);

      const isEventLike = !!(e && typeof e === 'object' && 'type' in e);
      const type = isEventLike ? String(e.type) : '';
      const base =
        (e instanceof Error) ? (e.message || 'Image failed to load') :
        isEventLike ? 'Image failed to load' :
        String(e || 'Image failed to load');
      const msg = src ? `${base}${type && !base.includes(type) ? ` (${type})` : ''} [${src}]` : base;
      reject(new Error(msg));
    };
    const cleanup = () => {
      clearTimeout(t);
      imgEl.removeEventListener('load', finishOk);
      imgEl.removeEventListener('error', finishErr);
    };

    const t = setTimeout(() => finishErr(new Error('Image load timeout')), timeoutMs);
    imgEl.addEventListener('load', finishOk, { once: true });
    imgEl.addEventListener('error', finishErr, { once: true });

    setTimeout(() => {
      if (imgEl.complete && imgEl.naturalWidth > 0) finishOk();
    }, 0);
  });
}

function arrayBufferToDataUrl(buffer, contentType){
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${contentType || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function base64ToArrayBuffer(b64){
  const bin = atob(String(b64 || ''));
  const len = bin.length;
  if (!len) throw new Error('Empty base64 payload');
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function normalizeToArrayBuffer(value){
  if (!value) return null;
  try{
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
  } catch {}
  return null;
}

function makeToast(text){
  if (!settings.showToast) return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = `
      position: fixed; left: 18px; bottom: 18px; z-index: 2147483647;
      background: rgba(20,18,24,.92); color: #fff; border: 1px solid rgba(255,127,200,.35);
      padding: 10px 12px; border-radius: 14px; font: 12px/1.2 system-ui;
      box-shadow: 0 16px 40px rgba(0,0,0,.35); backdrop-filter: blur(8px);
      pointer-events: none; max-width: 72vw;
    `;
    (document.body || document.documentElement).appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.opacity = '1';
  toastEl.style.transition = 'none';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{
    if (!toastEl) return;
    toastEl.style.opacity = '0';
    toastEl.style.transition = 'opacity .28s ease';
  }, 2600);
}

function sparkle(rect){
  // cute little sparkle burst near bottom-left of the image
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; left: ${Math.max(12, rect.left + 20)}px; top: ${Math.max(12, rect.top + rect.height - 40)}px;
    width: 140px; height: 70px; pointer-events:none; z-index:2147483647;
  `;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes muSpark { 
      0%{ transform: translate(0,0) scale(.6); opacity:0; }
      20%{ opacity:1; }
      100%{ transform: translate(var(--dx), var(--dy)) scale(1.2); opacity:0; }
    }
  `;
  root.appendChild(style);

  for (let i=0;i<10;i++){
    const s = document.createElement('div');
    const dx = (Math.random()*120 - 20).toFixed(0)+'px';
    const dy = (Math.random()*-60).toFixed(0)+'px';
    const size = (6 + Math.random()*10).toFixed(0)+'px';
    s.style.cssText = `
      position:absolute; left:${(10+Math.random()*50).toFixed(0)}px; top:${(18+Math.random()*18).toFixed(0)}px;
      width:${size}; height:${size};
      background: radial-gradient(circle, rgba(255,255,255,.95), rgba(255,127,200,.85) 45%, rgba(165,139,255,0) 70%);
      border-radius: 999px;
      filter: blur(.2px);
      animation: muSpark ${0.6 + Math.random()*0.35}s ease-out forwards;
      --dx:${dx}; --dy:${dy};
    `;
    root.appendChild(s);
  }

  (document.body || document.documentElement).appendChild(root);
  setTimeout(()=>root.remove(), 900);
}

function showOverlay(_rect, text){
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed;
    left: 18px;
    bottom: 64px;
    z-index: 2147483647;
    pointer-events: none;
  `;
  root.innerHTML = `
    <div style="
      display:flex; align-items:center; gap:10px;
      background: rgba(20,18,24,.72);
      color:#fff;
      border:1px solid rgba(255,255,255,.16);
      border-radius: 14px;
      padding: 10px 12px;
      box-shadow: 0 16px 40px rgba(0,0,0,.35);
      backdrop-filter: blur(10px);
      font: 12px/1.2 system-ui;
    ">
      <div style="
        width:14px; height:14px; border-radius: 999px;
        border: 2px solid rgba(255,255,255,.25);
        border-top-color: rgba(255,127,200,.95);
        animation: muSpin .8s linear infinite;
      "></div>
      <div>${String(text || 'Enhancing…')}</div>
    </div>
    <style>
      @keyframes muSpin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
    </style>
  `;
  (document.body || document.documentElement).appendChild(root);
  return () => { try { root.remove(); } catch {} };
}

function isComixReader(){
  try { return location.hostname === 'comix.to'; } catch { return false; }
}

// Pick the "panel in view": largest visible <img> by viewport intersection area.
function findBestVisibleImage(){
  const vw = window.innerWidth, vh = window.innerHeight;
  const centerY = vh / 2;
  const centerX = vw / 2;

  const scoreImg = (img, area) => {
    try{
      const r = img.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = Math.abs(cx - centerX) / Math.max(1, vw);
      const dy = Math.abs(cy - centerY) / Math.max(1, vh);
      // Prefer "near center" even if only partially visible.
      const centerBoost = 1 / (1 + dx + dy * 1.4);
      // On comix.to, we care more about what you're currently approaching (top-of-panel included).
      const comixBoost = isComixReader() ? 1.15 : 1.0;
      return area * centerBoost * comixBoost;
    }catch{
      return area;
    }
  };

  if (visibleScores && visibleScores.size > 0){
    let best = null;
    let bestScore = 0;
    for (const [img, area] of visibleScores){
      if (!img || !img.isConnected || !(img.currentSrc || img.src)) {
        visibleScores.delete(img);
        continue;
      }
      const u = getBestImageUrl(img);
      if (!u || isEmptyBase64DataUrl(u)) {
        visibleScores.delete(img);
        continue;
      }
      const s = scoreImg(img, area);
      if (s > bestScore){
        bestScore = s;
        best = img;
      }
    }
    if (best) return best;
  }

  const imgs = Array.from(document.images || []);
  let best = null;
  let bestScore = 0;

  for (const img of imgs){
    if (!img || !(img.currentSrc || img.src)) continue;
    const u = getBestImageUrl(img);
    if (!u || isEmptyBase64DataUrl(u)) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;

    const iw = Math.min(r.right, vw) - Math.max(r.left, 0);
    const ih = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (iw <= 0 || ih <= 0) continue;

    const area = iw * ih;
    const score = scoreImg(img, area);
    if (score > bestScore){
      bestScore = score;
      best = img;
    }
  }
  return best;
}

// ---------- Image fetch ----------
async function fetchImageAsDataURL(url){
  // Already data URL?
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (!match) throw new Error('Invalid data URL');
    if (!match[2]) throw new Error('Empty data URL');
    return url;
  }

  // Blob URLs are page-scoped; fetch them in the content script.
  if (url.startsWith('blob:')) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return await blobToDataURL(blob);
  }

  // Ask background to fetch, avoids CORS taint.
  const resp = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_DATAURL', url, pageUrl: location.href });
  if (!resp?.ok) throw new Error(resp?.error || 'Failed to fetch');
  return resp.dataUrl;
}

function loadImage(dataUrl){
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => {
      const raw = String(im.src || '');
      const src =
        raw.startsWith('data:') ? 'data:.' :
        raw.startsWith('blob:') ? raw.slice(0, 120) :
        raw.slice(0, 240);
      reject(new Error(`Image decode failed [${src}]`));
    };
    im.src = dataUrl;
  });
}

async function sniffMimeFromBlob(blob){
  try{
    const buf = await blob.slice(0, 32).arrayBuffer();
    const u = new Uint8Array(buf);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (u.length >= 8 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47) return 'image/png';
    // JPEG: FF D8 FF
    if (u.length >= 3 && u[0] === 0xFF && u[1] === 0xD8 && u[2] === 0xFF) return 'image/jpeg';
    // WebP: "RIFF"...."WEBP"
    if (u.length >= 12) {
      const riff = String.fromCharCode(u[0],u[1],u[2],u[3]);
      const webp = String.fromCharCode(u[8],u[9],u[10],u[11]);
      if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    }
  } catch {}
  return '';
}

async function decodeBlobToBitmap(blob){
  const errs = [];
  // 1) createImageBitmap works for most cases and is not subject to page img-src CSP.
  try{
    return await createImageBitmap(blob);
  } catch (e) {
    errs.push(`createImageBitmap: ${String(e?.message || e || 'failed')}`);
  }

  // 2) WebCodecs ImageDecoder fallback when available (also bypasses img-src CSP).
  try{
    if (typeof ImageDecoder !== 'undefined') {
      const sniff = await sniffMimeFromBlob(blob);
      const type = (blob.type && blob.type !== 'application/octet-stream') ? blob.type : (sniff || 'image/webp');
      // ImageDecoder expects ReadableStream/ArrayBuffer/ArrayBufferView, not a Blob.
      const data = await blob.arrayBuffer();
      const dec = new ImageDecoder({ data, type });
      const frame = await dec.decode({ frameIndex: 0 });
      try { await dec.close(); } catch {}
      return frame.image;
    }
    errs.push('ImageDecoder: unavailable');
  } catch (e) {
    errs.push(`ImageDecoder: ${String(e?.message || e || 'failed')}`);
  }

  throw new Error(`AI image decode failed: ${errs.join(' | ')}`);
}

// ---------- AI enhancement ----------

function blobToDataURL(blob){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = ()=>reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function enhanceViaHost(srcUrl, opts={}){
  if (!srcUrl) throw new Error('Missing image url');
  const scale = clamp(Number(settings.scale || 3), 2, 4);
  const quality = String(settings.aiQuality || 'balanced');
  const format = String(opts.format || 'webp');
  if (Date.now() < aiHostDownUntil) throw new Error('AI host cooldown');

  maybeStartHost('enhance');

  // If the host is cold-starting or loading a model, the first request can take a while.
  let slowHintTimer = setTimeout(()=>{
    makeToast('AI working… (first run may take longer)');
  }, 1200);

  let resp;
  try{
    // Avoid swapping the page's <img> to http://127.0.0.1/... because many sites trigger
    // Chrome Private Network Access (PNA) blocks. Always fetch via extension background
    // and inject a blob: URL into the page.
    if (isHttpUrl(srcUrl)) {
      resp = await chrome.runtime.sendMessage({
        type: 'FETCH_AI_ENHANCE',
        sourceUrl: srcUrl,
        scale,
        quality,
        format
      });
    } else {
      const dataUrl = await fetchImageAsDataURL(srcUrl);
      resp = await chrome.runtime.sendMessage({
        type: 'FETCH_AI_ENHANCE',
        dataUrl,
        scale,
        quality,
        format
      });
    }
  } finally {
    clearTimeout(slowHintTimer);
  }

  if (!resp?.ok) {
    aiHostFailCount = (aiHostFailCount || 0) + 1;
    // Only cooldown after repeated failures, otherwise normal scrolling can trigger cooldowns.
    if (aiHostFailCount >= 5) {
      aiHostDownUntil = Date.now() + 20000;
      aiHostFailCount = 0;
      throw new Error('AI host cooldown');
    }
    throw new Error(resp?.error || 'AI host not available');
  }
  aiHostFailCount = 0;
  if (resp.hostError) {
    throw new Error(resp.hostError);
  }
  // Prefer chunked streaming to avoid sendMessage truncation on large images.
  if (resp.streamId) {
    const streamId = String(resp.streamId || '');
    const chunkCount = Number(resp.chunkCount || 0);
    const total = Number(resp.byteLength || 0);
    const contentType = String(resp.contentType || 'image/png');
    if (!streamId || !chunkCount || !total) throw new Error('AI returned invalid stream');

    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunkCount; i++) {
      let r = await chrome.runtime.sendMessage({ type: 'AI_STREAM_CHUNK', streamId, index: i });
      if (!r?.ok) throw new Error(r?.error || 'Stream chunk failed');
      let ab = normalizeToArrayBuffer(r.chunk);
      if (!ab && r?.b64) {
        ab = base64ToArrayBuffer(r.b64);
      }
      if (!ab) {
        // Retry via base64 transport as a last resort (slower but very robust).
        const r2 = await chrome.runtime.sendMessage({ type: 'AI_STREAM_CHUNK_B64', streamId, index: i });
        if (!r2?.ok) throw new Error(r2?.error || 'Stream chunk failed');
        if (!r2?.b64) throw new Error('Invalid stream chunk');
        ab = base64ToArrayBuffer(r2.b64);
      }
      const u8 = new Uint8Array(ab);
      out.set(u8, offset);
      offset += u8.length;
    }
    chrome.runtime.sendMessage({ type: 'AI_STREAM_DELETE', streamId }).catch(()=>{});

    const blob = new Blob([out.buffer.slice(0, offset)], { type: contentType });
    if (!blob.size) throw new Error('AI returned empty image');
    const objectUrl = URL.createObjectURL(blob);
    return {
      src: objectUrl,
      isObjectUrl: true,
      model: resp.model || '',
      elapsedMs: resp.elapsedMs || 0,
      blob,
      contentType: contentType
    };
  }

  // Back-compat: allow direct buffer (small results).
  if (resp.buffer) {
    const ab = normalizeToArrayBuffer(resp.buffer);
    if (!ab) throw new Error('AI returned invalid payload');
    const blob = new Blob([ab], { type: resp.contentType || 'image/png' });
    if (!blob.size) throw new Error('AI returned empty image');
    const objectUrl = URL.createObjectURL(blob);
    return { src: objectUrl, isObjectUrl: true, model: resp.model || '', elapsedMs: resp.elapsedMs || 0, blob, contentType: (resp.contentType || blob.type || 'image/png') };
  }

  return { src: resp.dataUrl, isObjectUrl: false, model: resp.model || '', elapsedMs: resp.elapsedMs || 0 };
}

// ---------- Replace in page ----------
function replaceImgSrc(imgEl, newSrc, isObjectUrl=false){
  const rect = imgEl.getBoundingClientRect();
  const hasSizing = !!(imgEl.style.width || imgEl.style.height || imgEl.getAttribute('width') || imgEl.getAttribute('height'));
  if (!imgEl.dataset.muStyleWidth) {
    imgEl.dataset.muStyleWidth = imgEl.style.width || '';
  }
  if (!imgEl.dataset.muStyleHeight) {
    imgEl.dataset.muStyleHeight = imgEl.style.height || '';
  }
  if (!('muStyleObjectFit' in imgEl.dataset)) {
    imgEl.dataset.muStyleObjectFit = imgEl.style.objectFit || '';
  }
  if (!('muSrcset' in imgEl.dataset)) {
    imgEl.dataset.muSrcset = imgEl.getAttribute('srcset') || '';
  }
  if (!('muSizes' in imgEl.dataset)) {
    imgEl.dataset.muSizes = imgEl.getAttribute('sizes') || '';
  }
  if (!hasSizing && rect.width > 0 && rect.height > 0) {
    imgEl.style.width = `${Math.round(rect.width)}px`;
    imgEl.style.height = `${Math.round(rect.height)}px`;
    imgEl.style.objectFit = 'contain';
  }
  imgEl.dataset.muOriginalSrc = imgEl.dataset.muOriginalSrc || (imgEl.currentSrc || imgEl.src);

  const prevObjectUrl = imgEl.dataset.muObjectUrl || '';
  if (prevObjectUrl && prevObjectUrl !== newSrc) {
    try { URL.revokeObjectURL(prevObjectUrl); } catch {}
  }
  if (isObjectUrl) {
    imgEl.dataset.muObjectUrl = newSrc;
  } else {
    delete imgEl.dataset.muObjectUrl;
  }

  // Some sites use <picture>/<img srcset>; ensure our replacement is used.
  try { imgEl.removeAttribute('srcset'); } catch {}
  try { imgEl.removeAttribute('sizes'); } catch {}

  imgEl.src = newSrc;
  imgEl.style.imageRendering = 'auto';
}

function restoreImg(imgEl){
  if (!imgEl) return;

  const prevObjectUrl = imgEl.dataset.muObjectUrl || '';
  if (prevObjectUrl) {
    try { URL.revokeObjectURL(prevObjectUrl); } catch {}
    delete imgEl.dataset.muObjectUrl;
  }

  const originalSrc = imgEl.dataset.muOriginalSrc;
  if (originalSrc) {
    imgEl.src = originalSrc;
  }

  if ('muSrcset' in imgEl.dataset) {
    const v = imgEl.dataset.muSrcset;
    if (v) imgEl.setAttribute('srcset', v);
    else imgEl.removeAttribute('srcset');
  }
  if ('muSizes' in imgEl.dataset) {
    const v = imgEl.dataset.muSizes;
    if (v) imgEl.setAttribute('sizes', v);
    else imgEl.removeAttribute('sizes');
  }

  if ('muStyleWidth' in imgEl.dataset) imgEl.style.width = imgEl.dataset.muStyleWidth || '';
  if ('muStyleHeight' in imgEl.dataset) imgEl.style.height = imgEl.dataset.muStyleHeight || '';
  if ('muStyleObjectFit' in imgEl.dataset) imgEl.style.objectFit = imgEl.dataset.muStyleObjectFit || '';

  delete imgEl.dataset.muUpscaled;
}

function restoreAllUpscaledImages(){
  try{
    const imgs = Array.from(document.images || []);
    for (const img of imgs){
      if (!img) continue;
      const wasUpscaled = img.dataset?.muUpscaled === '1' || !!img.dataset?.muOriginalSrc;
      if (!wasUpscaled) continue;
      try { restoreImg(img); } catch {}
      try { clearCanvasOverlay(img); } catch {}
      try { delete img.dataset.muFailUntil; } catch {}
    }
  } catch {}
}

function restorePreloadPageTweaks(){
  try{
    const imgs = Array.from(document.images || []);
    for (const img of imgs){
      const orig = img?.dataset?.muPageOriginalSrc;
      if (!orig) continue;
      try { img.src = orig; } catch {}
      try { delete img.dataset.muPageOriginalSrc; } catch {}
      try{
        const ss = img?.dataset?.muPageOriginalSrcset;
        if (typeof ss === 'string') {
          img.setAttribute('srcset', ss);
        }
      } catch {}
      try { delete img.dataset.muPageOriginalSrcset; } catch {}
    }
  } catch {}
}

function isWeebCentral(){
  try { return location.hostname === 'weebcentral.com' || location.hostname.endsWith('.weebcentral.com'); } catch { return false; }
}

function getPreloadKeyForUrl(url){
  const scale = clamp(Number(settings.scale || 3), 2, 4);
  const quality = String(settings.aiQuality || 'balanced');
  const format = 'webp';
  return `${url}::s=${scale}::q=${quality}::f=${format}`;
}

function _evictEnhancedPreloadIfNeeded(){
  const now = Date.now();
  for (const [k, v] of enhancedPreloadCache) {
    if (!v?.createdAt || (now - Number(v.createdAt || 0)) > ENHANCED_PRELOAD_TTL_MS) {
      enhancedPreloadTotalBytes -= Number(v?.byteLength || 0);
      enhancedPreloadCache.delete(k);
    }
  }

  while (enhancedPreloadCache.size > ENHANCED_PRELOAD_MAX_ENTRIES || enhancedPreloadTotalBytes > ENHANCED_PRELOAD_MAX_BYTES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of enhancedPreloadCache) {
      const t = Number(v?.lastUsedAt || v?.createdAt || 0);
      if (t < oldestAt) { oldestAt = t; oldestKey = k; }
    }
    if (!oldestKey) break;
    const v = enhancedPreloadCache.get(oldestKey);
    enhancedPreloadTotalBytes -= Number(v?.byteLength || 0);
    enhancedPreloadCache.delete(oldestKey);
  }
}

function getEnhancedPreloadEntry(key){
  _evictEnhancedPreloadIfNeeded();
  const v = enhancedPreloadCache.get(key);
  if (!v) return null;
  v.lastUsedAt = Date.now();
  return v;
}

function touchPagePreload(imgEl, url){
  // Try to make upcoming panels load visually sooner without swapping anything to blob/data.
  // 1) Prefer browser-native lazyload hints.
  try { imgEl.loading = 'eager'; } catch {}
  try { imgEl.decoding = 'async'; } catch {}
  try { imgEl.fetchPriority = 'high'; } catch {}

  // 2) If this <img> is still a placeholder, set its src to the real URL so the page shows it.
  // Only do this for obvious placeholders to avoid fighting the site's own loader.
  try{
    const cur = String(imgEl.currentSrc || imgEl.src || '');
    const isPlaceholder =
      !cur ||
      cur === 'about:blank' ||
      isEmptyBase64DataUrl(cur) ||
      cur.startsWith('data:image/gif') ||
      cur.includes('transparent') ||
      cur.includes('placeholder');

    if (isPlaceholder && isHttpUrl(url)) {
      if (!imgEl.dataset.muPageOriginalSrc) imgEl.dataset.muPageOriginalSrc = cur;
      // Clear srcset if it only contains placeholder entries.
      try{
        const ss = String(imgEl.getAttribute('srcset') || '');
        if (ss && !ss.includes('http://') && !ss.includes('https://')) {
          imgEl.dataset.muPageOriginalSrcset = ss;
          imgEl.setAttribute('srcset', '');
        }
      } catch {}
      imgEl.src = url;
    }
  } catch {}
}

function prefetchUrl(url){
  if (!isHttpUrl(url)) return;
  const until = pagePrefetch.get(url) || 0;
  if (until && Date.now() < until) return;
  pagePrefetch.set(url, Date.now() + 60000);
  try{
    const im = new Image();
    im.decoding = 'async';
    im.referrerPolicy = 'no-referrer';
    im.src = url;
  } catch {}
}

function scheduleAfterCooldown(preload){
  cooldownRetryPreload = !!preload;
  if (cooldownRetryTimer) return;
  const waitMs = Math.max(0, aiHostDownUntil - Date.now()) + 600;
  cooldownRetryTimer = setTimeout(() => {
    cooldownRetryTimer = null;
    processOnce(cooldownRetryPreload, true).catch(()=>{});
  }, waitMs);
}

async function fetchEnhancedBlobForUrl(srcUrl, opts={}){
  const scale = clamp(Number(settings.scale || 3), 2, 4);
  const quality = String(settings.aiQuality || 'balanced');
  const format = String(opts.format || 'webp');

  const resp = await chrome.runtime.sendMessage({
    type: 'FETCH_AI_ENHANCE',
    sourceUrl: srcUrl,
    scale,
    quality,
    format
  });
  if (!resp?.ok) throw new Error(resp?.error || 'AI host not available');
  if (resp.hostError) throw new Error(resp.hostError);

  const contentType = String(resp.contentType || 'image/png');

  if (resp.streamId) {
    const streamId = String(resp.streamId || '');
    const chunkCount = Number(resp.chunkCount || 0);
    const total = Number(resp.byteLength || 0);
    if (!streamId || !chunkCount || !total) throw new Error('AI returned invalid stream');

    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunkCount; i++) {
      let r = await chrome.runtime.sendMessage({ type: 'AI_STREAM_CHUNK', streamId, index: i });
      if (!r?.ok) throw new Error(r?.error || 'Stream chunk failed');
      let ab = normalizeToArrayBuffer(r.chunk);
      if (!ab && r?.b64) ab = base64ToArrayBuffer(r.b64);
      if (!ab) {
        const r2 = await chrome.runtime.sendMessage({ type: 'AI_STREAM_CHUNK_B64', streamId, index: i });
        if (!r2?.ok) throw new Error(r2?.error || 'Stream chunk failed');
        if (!r2?.b64) throw new Error('Invalid stream chunk');
        ab = base64ToArrayBuffer(r2.b64);
      }
      const u8 = new Uint8Array(ab);
      out.set(u8, offset);
      offset += u8.length;
    }
    chrome.runtime.sendMessage({ type: 'AI_STREAM_DELETE', streamId }).catch(()=>{});
    const blob = new Blob([out.buffer.slice(0, offset)], { type: contentType });
    if (!blob.size) throw new Error('AI returned empty image');
    return { blob, contentType, model: String(resp.model || '') };
  }

  if (resp.buffer) {
    const ab = normalizeToArrayBuffer(resp.buffer);
    if (!ab) throw new Error('AI returned invalid payload');
    const blob = new Blob([ab], { type: contentType });
    if (!blob.size) throw new Error('AI returned empty image');
    return { blob, contentType, model: String(resp.model || '') };
  }

  throw new Error('AI returned invalid payload');
}

function bumpAiBurstAndMaybeCooldown(countForCooldown, preload){
  if (!countForCooldown) return false;
  const now = Date.now();
  // If it's been a while since the last successful enhance, reset the burst counter.
  if (!aiBurstLastAt || (now - aiBurstLastAt) > 25000) {
    aiBurstCount = 0;
  }
  aiBurstLastAt = now;
  aiBurstCount += 1;

  const limit = 8;
  if (aiBurstCount < limit) return false;

  aiBurstCount = 0;
  aiHostDownUntil = now + 8000;
  scheduleAfterCooldown(preload);

  if (Date.now() > cooldownNotifiedUntil) {
    cooldownNotifiedUntil = aiHostDownUntil;
    makeToast('AI cooling down. will continue soon');
  }

  return true;
}

function getNextCandidateImages(currentImg, n){
  if (n <= 0) return [];

  const curRect = currentImg.getBoundingClientRect();
  const curTop = curRect.top + window.scrollY;
  const curW = Math.max(1, curRect.width || currentImg.naturalWidth || 0);
  const curH = Math.max(1, curRect.height || currentImg.naturalHeight || 0);
  const minW = Math.max(isWeebCentral() ? 320 : 220, curW * 0.55);
  const minH = Math.max(isWeebCentral() ? 320 : 220, curH * 0.55);

  const imgs = Array.from(document.images || []).filter(i => {
    if (!i || i === currentImg) return false;
    if (i.dataset?.muUpscaled === '1') return false;
    const u = getBestImageUrl(i);
    if (!u || isEmptyBase64DataUrl(u)) return false;
    const r = i.getBoundingClientRect();
    if (!r || r.width < minW || r.height < minH) return false;
    const top = r.top + window.scrollY;
    // keep candidates in a reasonable window below/around the current panel
    if (top < (curTop - window.innerHeight * 0.5)) return false;
    const maxScreens = isWeebCentral() ? 5.0 : 8.0;
    if (top > (curTop + window.innerHeight * maxScreens)) return false;
    return true;
  });

  // Prefer DOM order / visual order below the current panel.
  const ordered = imgs
    .map(i => ({ i, top: i.getBoundingClientRect().top + window.scrollY }))
    .sort((a, b) => a.top - b.top);

  const below = ordered.filter(x => x.top > (curTop + 4)).slice(0, n).map(x => x.i);
  if (below.length >= n) return below;

  // Fallback: nearest by distance.
  const scored = ordered.map(x => ({ i: x.i, d: Math.abs(x.top - curTop), below: x.top >= curTop ? 0 : 1 }))
    .sort((a,b)=> (a.below - b.below) || (a.d - b.d));
  return scored.slice(0, n).map(x=>x.i);
}

async function preloadAiForImage(imgEl){
  if (!imgEl) return false;
  const src = getBestImageUrl(imgEl);
  if (!src || !isHttpUrl(src) || isEmptyBase64DataUrl(src)) return false;

  // This is "pre-upscale": fetch the enhanced output ahead of time so it can be swapped in instantly.
  // The host will still cache it on disk.
  if (Date.now() < aiHostDownUntil) throw new Error('AI host cooldown');

  const key = getPreloadKeyForUrl(src);
  const prevKey = String(imgEl.dataset?.muPreloadKey || '');
  const until = Number(imgEl.dataset?.muPreloadUntil || 0);
  if (prevKey === key && until && Date.now() < until && getEnhancedPreloadEntry(key)) return true;

  imgEl.dataset.muPreloadKey = key;
  imgEl.dataset.muPreloadUntil = String(Date.now() + ENHANCED_PRELOAD_TTL_MS);

  // Preload the actual page image too (so scrolling doesn't show blank placeholders).
  prefetchUrl(src);
  touchPagePreload(imgEl, src);

  maybeStartHost('preload_fetch');
  const out = await fetchEnhancedBlobForUrl(src, { format: 'webp' });

  _evictEnhancedPreloadIfNeeded();
  const prev = enhancedPreloadCache.get(key);
  if (prev) enhancedPreloadTotalBytes -= Number(prev.byteLength || 0);

  const entry = {
    blob: out.blob,
    contentType: out.contentType,
    model: out.model,
    byteLength: Number(out.blob.size || 0),
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  };
  enhancedPreloadCache.set(key, entry);
  enhancedPreloadTotalBytes += entry.byteLength;
  _evictEnhancedPreloadIfNeeded();
  return true;
}

function computePreloadStatus(currentImg){
  const target = clamp(Number(settings.preUpscaleCount || 0), 0, 5);
  const next = getNextCandidateImages(currentImg, target);
  let preloaded = 0;
  let prefetched = 0;
  for (const ni of next){
    const url = getBestImageUrl(ni);
    if (!url || !isHttpUrl(url)) continue;
    const key = getPreloadKeyForUrl(url);
    const ok = (String(ni.dataset?.muPreloadKey || '') === key) && (Number(ni.dataset?.muPreloadUntil || 0) > Date.now());
    if (ok && getEnhancedPreloadEntry(key)) preloaded++;
    const u2 = pagePrefetch.get(url) || 0;
    if (u2 && Date.now() < u2) prefetched++;
  }
  preloadStatus = {
    target,
    preloaded,
    prefetched,
    updatedAt: Date.now(),
    currentUrl: String(getBestImageUrl(currentImg) || '')
  };
}

function isNearViewport(imgEl){
  try{
    const r = imgEl.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    return (r.top < vh * 1.25) && (r.bottom > -vh * 0.25);
  } catch {
    return false;
  }
}

async function applyEnhancedCacheIfReady(imgEl, opts={}){
  if (!imgEl) return false;
  if (imgEl.dataset?.muUpscaled === '1') return false;
  const src = getBestImageUrl(imgEl);
  if (!src || !isHttpUrl(src)) return false;
  const key = getPreloadKeyForUrl(src);
  const entry = getEnhancedPreloadEntry(key);
  if (!entry?.blob) return false;

  // Ensure the page is also loading this image (prevents "blank page" while scrolling).
  prefetchUrl(src);
  touchPagePreload(imgEl, src);

  if (!opts.force && !isNearViewport(imgEl)) return false;

  const outBlob = entry.blob;
  const objectUrl = URL.createObjectURL(outBlob);

  const setAndWait = async (newSrc, isObj) => {
    replaceImgSrc(imgEl, newSrc, isObj);
    await waitForImageLoad(imgEl, 20000);
  };

  try{
    await setAndWait(objectUrl, true);
  } catch {
    try { restoreImg(imgEl); } catch {}
    try{
      const dataUrl = await blobToDataURL(outBlob);
      await setAndWait(dataUrl, false);
    } catch {
      await renderBlobOverImage(imgEl, outBlob);
    }
  }

  imgEl.dataset.muUpscaled = '1';
  // No sparkle/toast: preloaded swaps should feel invisible.
  return true;
}

async function processImageElement(imgEl){
  // Skip if we recently failed this element (prevents flicker + host spam).
  const failUntil = Number(imgEl?.dataset?.muFailUntil || 0);
  if (failUntil && Date.now() < failUntil) return;

  const src = getBestImageUrl(imgEl);
  if (!src || isEmptyBase64DataUrl(src)) throw new Error('No usable image source');

  // If already upscaled by us, skip
  if (imgEl.dataset.muUpscaled === '1') return;

  const rect = imgEl.getBoundingClientRect();
  let removeOverlay = null;
  let overlayTimer = setTimeout(()=>{
    removeOverlay = showOverlay(rect, 'AI enhancing…');
  }, 650);

  let model = '';
  try{
    let out;
    let outIsObjectUrl = false;
    let outBlob = null;
    let outContentType = '';

    const ai = await enhanceViaHost(src);
    out = ai.src;
    model = ai.model;
    outIsObjectUrl = !!ai.isObjectUrl;
    outBlob = ai.blob || null;
    outContentType = ai.contentType || '';

    const setAndWait = async (newSrc, isObj) => {
      replaceImgSrc(imgEl, newSrc, isObj);
      await waitForImageLoad(imgEl, 20000);
    };

    try{
      await setAndWait(out, outIsObjectUrl);
    } catch (e1) {
      // If blob: is blocked by CSP, fall back to data: generated from the Blob.
      if (outIsObjectUrl && outBlob) {
        // Restore original <img> state first (so we don't leave a broken blob: src behind),
        // then either try data: or draw into a <canvas> overlay if CSP blocks both.
        try { restoreImg(imgEl); } catch {}

        try{
          const dataUrl = await blobToDataURL(outBlob);
          if (!/^data:[^;]+;base64,.+/.test(dataUrl)) {
            throw new Error('AI returned empty image');
          }
          await setAndWait(dataUrl, false);
        } catch (e2) {
          // Strict CSP often blocks data:/blob: in <img>. Canvas overlay still works.
          try{
            await renderBlobOverImage(imgEl, outBlob);
          } catch (e3) {
            // Some sites block blob/data for <img>, and some browsers can fail to decode webp via createImageBitmap.
            // Retry once using PNG from host, then render overlay.
            const msg = String(e3?.message || e3 || '');
            if (msg.includes('AI image decode failed')) {
              const aiPng = await enhanceViaHost(src, { format: 'png' });
              if (aiPng?.blob) {
                await renderBlobOverImage(imgEl, aiPng.blob);
              } else {
                throw e3;
              }
            } else {
              throw e3;
            }
          }
        }
      } else {
        throw e1;
      }
    }
  } catch (e) {
    // On failure, restore the original image so we don't leave a broken data:/blob: src behind.
    try { restoreImg(imgEl); } catch {}
    try { clearCanvasOverlay(imgEl); } catch {}
    try {
      const msg = String(e?.message || e || '');
      const backoff = msg.includes('decode') ? 60000 : 15000;
      imgEl.dataset.muFailUntil = String(Date.now() + backoff);
    } catch {}
    throw e;
  } finally {
    clearTimeout(overlayTimer);
    if (removeOverlay) removeOverlay();
  }

  imgEl.dataset.muUpscaled = '1';
  sparkle(imgEl.getBoundingClientRect());

  chrome.runtime.sendMessage({ type: 'BADGE_UP' }).catch(()=>{});
  const label = model ? ('AI ' + model) : 'AI enhanced';
  makeToast(label);}

async function processOnce(preload, showStatus){
  if (!settings.enabled) return;
  if (!hostAllowed()) return;

  if (Date.now() < aiHostDownUntil) {
    scheduleAfterCooldown(preload);
    if (Date.now() > cooldownNotifiedUntil) {
      cooldownNotifiedUntil = aiHostDownUntil || (Date.now() + 20000);
      makeToast('AI cooling down. will retry soon');
    }
    return;
  }

  if (busy) return;
  busy = true;
  try{
    if (showStatus){
      makeToast(preload ? 'AI enhancing + preload...' : 'AI enhancing...');
    }
    const img = findBestVisibleImage();
    if (!img) { makeToast('No panel found'); return; }

    // Burst cooldown is only for auto mode; manual Enhance/Preload should do what the user asked.
    const manual = !!showStatus;
    const shouldBurstLimit = settings.autoPanel && !manual;
    await processImageElement(img);
    if (shouldBurstLimit && bumpAiBurstAndMaybeCooldown(true, preload)) return;

    if (preload){
      const nextCount = clamp(Number(settings.preUpscaleCount||0), 0, 5);
      const next = getNextCandidateImages(img, nextCount);
      for (const ni of next){
        try{
          // Pre-upscale: fetch enhanced outputs now, so the next panels are already swapped before you see them.
          await preloadAiForImage(ni);
          try { await applyEnhancedCacheIfReady(ni); } catch {}
        }catch(e){
          const msg = String(e?.message || e || '');
          if (msg.includes('AI host cooldown')) {
            scheduleAfterCooldown(preload);
            if (Date.now() > cooldownNotifiedUntil) {
              cooldownNotifiedUntil = aiHostDownUntil || (Date.now() + 20000);
              makeToast('AI cooling down. will retry soon');
            }
            return;
          }
          // ignore per-item
        }
      }
    }

    // Update status after each cycle (so popup can show progress).
    try { computePreloadStatus(img); } catch {}

    // Apply any already-preloaded next panels that are near the viewport.
    try{
      const t = clamp(Number(settings.preUpscaleCount||0), 0, 5);
      const next = getNextCandidateImages(img, t);
      for (const ni of next){
        try { await applyEnhancedCacheIfReady(ni); } catch {}
      }
    } catch {}
  } catch(e){
    log('Enhance failed:', e);
    const msg = String(e?.message || e || '').slice(0, 120);
    if (msg.includes('AI host cooldown')) {
      scheduleAfterCooldown(preload);
      if (Date.now() > cooldownNotifiedUntil) {
        cooldownNotifiedUntil = aiHostDownUntil || (Date.now() + 20000);
        makeToast('AI cooling down… will retry soon');
      }
      return;
    }
    if (msg) makeToast(`AI failed: ${msg}`);
  } finally {
    busy = false;
  }
}

// ---------- Auto mode ----------
function startAuto(){
  if (observerStarted) return;
  observerStarted = true;

  let lastAutoKey = '';

  const onTick = () => {
    if (busy) return;
    if (!settings.enabled || !settings.autoPanel || !hostAllowed()) return;
    // Don't spam: only run if current visible image not yet processed
    const img = findBestVisibleImage();
    if (!img) return;

    // If we already pre-upscaled this (or a nearby next panel), swap it in before it becomes visible.
    try{
      applyEnhancedCacheIfReady(img).catch(()=>{});
      const t = clamp(Number(settings.preUpscaleCount||0), 0, 5);
      const next = getNextCandidateImages(img, t);
      for (const ni of next){
        if (isNearViewport(ni)) applyEnhancedCacheIfReady(ni).catch(()=>{});
      }
    } catch {}

    if (img.dataset.muUpscaled === '1') {
      // Even if current is already upscaled, keep preloading ahead as the user scrolls.
      const k = img.dataset.muOriginalSrc || img.currentSrc || img.src || '';
      const key = `${k}::n=${Number(settings.preUpscaleCount||0)}`;
      if (key && key !== lastAutoKey) {
        lastAutoKey = key;
        if (Number(settings.preUpscaleCount||0) > 0) {
          processOnce(true).catch(()=>{});
        }
      }
      return;
    }

    // Auto-preload is driven by the same slider; if you set it to >0, scrolling will keep the cache warm.
    const shouldPreload = Number(settings.preUpscaleCount||0) > 0;
    const k = img.dataset.muOriginalSrc || img.currentSrc || img.src || '';
    lastAutoKey = `${k}::n=${Number(settings.preUpscaleCount||0)}`;
    processOnce(shouldPreload).catch(()=>{});
  };

  let t = null;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(onTick, 260);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  // Prefer IntersectionObserver for smooth scrolling (avoids scanning every image on every tick).
  try{
    io = new IntersectionObserver((entries)=>{
      for (const e of entries){
        const img = e.target;
        if (!img || !img.src || !e.isIntersecting) {
          visibleScores.delete(img);
          continue;
        }
        const r = e.intersectionRect;
        if (!r || r.width < 80 || r.height < 80) {
          visibleScores.delete(img);
          continue;
        }
        visibleScores.set(img, r.width * r.height);
      }
      schedule();
    }, { threshold: [0, 0.15, 0.35, 0.65, 0.9] });

    for (const img of Array.from(document.images || [])){
      if (img && img.tagName === 'IMG') io.observe(img);
    }
  } catch {
    // ignore
  }

  // DOM changes (lazy-loaded pages): observe new <img> elements.
  const mo = new MutationObserver((muts)=>{
    for (const m of muts){
      for (const n of Array.from(m.addedNodes || [])){
        if (!n) continue;
        if (n.tagName === 'IMG') {
          try { io && io.observe(n); } catch {}
        } else if (n.querySelectorAll) {
          for (const img of Array.from(n.querySelectorAll('img'))){
            try { io && io.observe(img); } catch {}
          }
        }
      }
    }
    schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  schedule();
}

// ---------- Messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Allow returning a value for specific messages.
  if (msg?.type === 'GET_PRELOAD_STATUS') {
    try{
      const img = findBestVisibleImage();
      if (img) computePreloadStatus(img);
    } catch {}
    try { sendResponse(preloadStatus); } catch {}
    return true;
  }

  if (msg?.type === 'SETTINGS_UPDATED') {
    loadSettings().then(()=>{
      if (!settings.enabled || !hostAllowed()) {
        maybeStopHost('settings_update');
        restoreAllUpscaledImages();
        restorePreloadPageTweaks();
      } else {
        maybeStartHost('settings_update');
      }
    }).catch(()=>{});
  }
  if (msg?.type === 'RUN_ONCE') {
    processOnce(!!msg.preload, true);
  }
  if (msg?.type === 'ENHANCE_IMAGE_URL') {
    (async ()=>{
      try{
        if (!settings.enabled || !hostAllowed()) return;
        const url = String(msg?.url || '');
        if (!url) throw new Error('Missing image url');
        const imgs = Array.from(document.images || []);
        const target = imgs.find(i => {
          const u = getBestImageUrl(i);
          return u === url || i.currentSrc === url || i.src === url;
        });
        if (!target) throw new Error('Image element not found');
        await processImageElement(target);
      }catch(e){
        log('Context enhance failed:', e);
        makeToast(String(e?.message || e || 'Enhance failed'));
      }
    })();
  }
  if (msg?.type === 'HOST_START') {
    maybeStartHost(msg.reason || 'popup');
  }
  if (msg?.type === 'HOST_STOP') {
    maybeStopHost(msg.reason || 'popup');
  }
});

// ---------- Boot ----------
(async function init(){
  await loadSettings();

  if (!hostAllowed()) return; // no work on non-whitelisted sites

  if (settings.enabled) maybeStartHost('init');

  startAuto();
  log('Ready', { host: location.hostname, enabled: settings.enabled });
})();
