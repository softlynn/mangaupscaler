// Manga Upscaler content script (v1.1.0)
// Enhances the currently visible manga panel (largest visible image) by:
// 1) fetching the image data safely (via background to avoid CORS taint)
// 2) upscaling with progressive high-quality resampling
// 3) denoise + unsharp mask for crisp text/screentones
// 4) optional tiny watermark + sparkle + toast

const AI_HOST = 'http://127.0.0.1:48159';

const DEFAULTS = {
  enabled: true,
  autoPanel: true,
  scale: 3,
  preUpscaleCount: 1,          // 0..4
  sharpenStrength: 0.40,       // 0..1
  denoiseStrength: 0.15,       // 0..0.6
  quality: 'high',             // low/medium/high (canvas hint)
  aiQuality: 'balanced',       // fast/balanced/best
  whitelist: {},               // {hostname:true}
  showToast: true,
  watermark: true,
  aiMode: true
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

// ---------- Settings ----------
async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s, whitelist: s.whitelist || {} };
}

function maybeStartHost(reason){
  if (!settings.enabled || !settings.aiMode) return;
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

function showOverlay(rect, text){
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed;
    left: ${Math.max(0, rect.left)}px;
    top: ${Math.max(0, rect.top)}px;
    width: ${Math.max(0, rect.width)}px;
    height: ${Math.max(0, rect.height)}px;
    z-index: 2147483647;
    pointer-events: none;
    display: grid;
    place-items: center;
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

// Pick the "panel in view": largest visible <img> by viewport intersection area.
function findBestVisibleImage(){
  if (visibleScores && visibleScores.size > 0){
    let best = null;
    let bestScore = 0;
    for (const [img, score] of visibleScores){
      if (!img || !img.isConnected || !(img.currentSrc || img.src)) {
        visibleScores.delete(img);
        continue;
      }
      const u = getBestImageUrl(img);
      if (!u || isEmptyBase64DataUrl(u)) {
        visibleScores.delete(img);
        continue;
      }
      if (score > bestScore){
        bestScore = score;
        best = img;
      }
    }
    if (best) return best;
  }

  const imgs = Array.from(document.images || []);
  const vw = window.innerWidth, vh = window.innerHeight;
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

    const score = iw * ih;
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

// ---------- Enhancement pipeline ----------
function upscaleCanvas(srcImg, scale){
  const w = srcImg.naturalWidth || srcImg.width;
  const h = srcImg.naturalHeight || srcImg.height;

  // Progressive upscaling reduces blur vs 1 big step.
  const steps = [];
  let current = 1;
  while (current < scale){
    const next = Math.min(scale, current * 1.5);
    steps.push(next);
    current = next;
  }

  let canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = settings.quality || 'high';
  ctx.drawImage(srcImg, 0, 0);

  for (const s of steps){
    const tmp = document.createElement('canvas');
    tmp.width = Math.round(w * s);
    tmp.height = Math.round(h * s);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = settings.quality || 'high';
    tctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
    canvas = tmp;
    ctx = tctx;
  }
  return canvas;
}

function gaussianBlur3x3(imgData){
  // Lightweight blur for unsharp mask base (approx gaussian).
  const { data, width, height } = imgData;
  const out = new Uint8ClampedArray(data.length);
  const w = width, h = height;
  const k = [1,2,1, 2,4,2, 1,2,1];
  const ks = 16;

  for (let y=0;y<h;y++){
    for (let x=0;x<w;x++){
      let r=0,g=0,b=0,a=0, ki=0;
      for (let j=-1;j<=1;j++){
        const yy = clamp(y+j, 0, h-1);
        for (let i=-1;i<=1;i++){
          const xx = clamp(x+i, 0, w-1);
          const idx = (yy*w + xx)*4;
          const kv = k[ki++];
          r += data[idx]*kv;
          g += data[idx+1]*kv;
          b += data[idx+2]*kv;
          a += data[idx+3]*kv;
        }
      }
      const o = (y*w + x)*4;
      out[o]   = r/ks;
      out[o+1] = g/ks;
      out[o+2] = b/ks;
      out[o+3] = a/ks;
    }
  }
  return new ImageData(out, width, height);
}

function medianDenoise3x3(imgData, strength){
  // Very mild median on luma, blended back (helps JPEG blocks / scan noise).
  if (strength <= 0) return imgData;
  const { data, width, height } = imgData;
  const out = new Uint8ClampedArray(data.length);
  const w = width, h = height;

  const lum = (r,g,b)=> (0.2126*r + 0.7152*g + 0.0722*b);

  for (let y=0;y<h;y++){
    for (let x=0;x<w;x++){
      const lums = [];
      const idxs = [];
      for (let j=-1;j<=1;j++){
        const yy = clamp(y+j,0,h-1);
        for (let i=-1;i<=1;i++){
          const xx = clamp(x+i,0,w-1);
          const idx = (yy*w+xx)*4;
          idxs.push(idx);
          lums.push(lum(data[idx], data[idx+1], data[idx+2]));
        }
      }
      // median index
      const sorted = lums.map((v,ii)=>[v,ii]).sort((a,b)=>a[0]-b[0]);
      const mid = sorted[4][1];
      const mIdx = idxs[mid];

      const o = (y*w+x)*4;
      // blend towards median pixel
      out[o]   = data[o]   + (data[mIdx]   - data[o])   * strength;
      out[o+1] = data[o+1] + (data[mIdx+1] - data[o+1]) * strength;
      out[o+2] = data[o+2] + (data[mIdx+2] - data[o+2]) * strength;
      out[o+3] = data[o+3];
    }
  }
  return new ImageData(out, width, height);
}

function unsharpMask(imgData, blurred, amount){
  if (amount <= 0) return imgData;
  const { data, width, height } = imgData;
  const b = blurred.data;
  const out = new Uint8ClampedArray(data.length);

  // Edge-aware-ish: apply more where difference is stronger.
  for (let i=0;i<data.length;i+=4){
    const dr = data[i]   - b[i];
    const dg = data[i+1] - b[i+1];
    const db = data[i+2] - b[i+2];
    const diff = Math.abs(dr) + Math.abs(dg) + Math.abs(db); // 0..765
    const edge = clamp(diff / 220, 0, 1); // emphasis for text/lines
    const a = amount * (0.35 + 0.65*edge);

    out[i]   = clamp(data[i]   + dr*a, 0, 255);
    out[i+1] = clamp(data[i+1] + dg*a, 0, 255);
    out[i+2] = clamp(data[i+2] + db*a, 0, 255);
    out[i+3] = data[i+3];
  }
  return new ImageData(out, width, height);
}

async function applyWatermark(ctx, canvas){
  if (!settings.watermark) return;
  try{
    const url = chrome.runtime.getURL('assets/creator.png');
    const dataUrl = await fetch(url).then(r=>r.blob()).then(blobToDataURL);
    const im = await loadImage(dataUrl);

    const pad = Math.max(10, Math.round(canvas.width * 0.012));
    const size = Math.max(22, Math.round(canvas.width * 0.035)); // tiny
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.beginPath();
    ctx.roundRect(canvas.width - pad - size, canvas.height - pad - size, size, size, Math.round(size/3));
    ctx.clip();
    ctx.drawImage(im, canvas.width - pad - size, canvas.height - pad - size, size, size);
    ctx.restore();
  } catch {
    // ignore
  }
}

function blobToDataURL(blob){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=>resolve(r.result);
    r.onerror = ()=>reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function enhanceToDataURL(dataUrl){
  const img = await loadImage(dataUrl);
  const scale = clamp(Number(settings.scale || 3), 2, 4);

  const canvas = upscaleCanvas(img, scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Read pixels
  let id = ctx.getImageData(0,0,canvas.width,canvas.height);

  // Denoise
  id = medianDenoise3x3(id, clamp(Number(settings.denoiseStrength||0), 0, 0.6));

  // Blur for unsharp
  const blurred = gaussianBlur3x3(id);

  // Sharpen
  id = unsharpMask(id, blurred, clamp(Number(settings.sharpenStrength||0), 0, 1));

  ctx.putImageData(id, 0, 0);

  await applyWatermark(ctx, canvas);

  return canvas.toDataURL('image/png');
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
  if (resp.buffer) {
    const blob = new Blob([resp.buffer], { type: resp.contentType || 'image/png' });
    if (!blob.size) throw new Error('AI returned empty image');
    const objectUrl = URL.createObjectURL(blob);
    return {
      src: objectUrl,
      isObjectUrl: true,
      model: resp.model || '',
      elapsedMs: resp.elapsedMs || 0,
      blob,
      contentType: (resp.contentType || blob.type || 'image/png')
    };
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

function scheduleAfterCooldown(preload){
  cooldownRetryPreload = !!preload;
  if (cooldownRetryTimer) return;
  const waitMs = Math.max(0, aiHostDownUntil - Date.now()) + 600;
  cooldownRetryTimer = setTimeout(() => {
    cooldownRetryTimer = null;
    processOnce(cooldownRetryPreload, true).catch(()=>{});
  }, waitMs);
}

function bumpAiBurstAndMaybeCooldown(preload){
  const now = Date.now();
  // If it's been a while since the last successful enhance, reset the burst counter.
  if (!aiBurstLastAt || (now - aiBurstLastAt) > 45000) {
    aiBurstCount = 0;
  }
  aiBurstLastAt = now;
  aiBurstCount += 1;

  const limit = 5;
  if (aiBurstCount < limit) return false;

  aiBurstCount = 0;
  aiHostDownUntil = now + 20000;
  scheduleAfterCooldown(preload);

  if (Date.now() > cooldownNotifiedUntil) {
    cooldownNotifiedUntil = aiHostDownUntil;
    makeToast('AI cooling down. will continue soon');
  }

  return true;
}

function getNextCandidateImages(currentImg, n){
  if (n <= 0) return [];
  const imgs = Array.from(document.images || []).filter(i =>
    i &&
    i !== currentImg &&
    i.complete &&
    i.naturalWidth > 80 &&
    i.naturalHeight > 80 &&
    (i.currentSrc || i.src) &&
    i.dataset?.muUpscaled !== '1'
  );
  // Prefer those near/below the current image
  const curTop = currentImg.getBoundingClientRect().top + window.scrollY;
  const scored = imgs.map(i=>{
    const top = i.getBoundingClientRect().top + window.scrollY;
    return { i, d: Math.abs(top - curTop), below: top >= curTop ? 0 : 1 };
  }).sort((a,b)=> (a.below - b.below) || (a.d - b.d));
  return scored.slice(0, n).map(x=>x.i);
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
    removeOverlay = showOverlay(rect, settings.aiMode ? 'AI enhancing…' : 'Enhancing…');
  }, 650);

  let model = '';
  try{
    let out;
    let outIsObjectUrl = false;
    let outBlob = null;
    let outContentType = '';

    if (settings.aiMode) {
      const ai = await enhanceViaHost(src);
      out = ai.src;
      model = ai.model;
      outIsObjectUrl = !!ai.isObjectUrl;
      outBlob = ai.blob || null;
      outContentType = ai.contentType || '';
    } else {
      const data = await fetchImageAsDataURL(src);
      out = await enhanceToDataURL(data);
    }

    const setAndWait = async (newSrc, isObj) => {
      replaceImgSrc(imgEl, newSrc, isObj);
      await waitForImageLoad(imgEl, 20000);
    };

    try{
      await setAndWait(out, outIsObjectUrl);
    } catch (e1) {
      // If blob: is blocked by CSP, fall back to data: generated from the Blob.
      if (settings.aiMode && outIsObjectUrl && outBlob) {
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
  if (settings.aiMode) {
    const label = model ? `AI ${model}` : 'AI enhanced';
    makeToast(label);
  } else {
    makeToast(`Enhanced ${settings.scale}× • sharpen ${Number(settings.sharpenStrength).toFixed(2)}`);
  }
}

async function processOnce(preload, showStatus){
  if (!settings.enabled) return;
  if (!hostAllowed()) return;

  if (settings.aiMode && Date.now() < aiHostDownUntil) {
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
      makeToast(preload ? 'Enhancing + preload...' : 'Enhancing...');
    }
    const img = findBestVisibleImage();
    if (!img) { makeToast('No panel found'); return; }

    const shouldBurstLimit = settings.aiMode && (settings.autoPanel || preload);
    await processImageElement(img);
    if (shouldBurstLimit && bumpAiBurstAndMaybeCooldown(preload)) return;

    if (preload){
      const next = getNextCandidateImages(img, clamp(Number(settings.preUpscaleCount||0), 0, 4));
      for (const ni of next){
        try{
          await processImageElement(ni);
          if (shouldBurstLimit && bumpAiBurstAndMaybeCooldown(preload)) return;
        }catch(e){
          const msg = String(e?.message || e || '');
          if (settings.aiMode && msg.includes('AI host cooldown')) {
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
  } catch(e){
    log('Enhance failed:', e);
    const msg = String(e?.message || e || '').slice(0, 120);
    if (settings.aiMode && msg.includes('AI host cooldown')) {
      scheduleAfterCooldown(preload);
      if (Date.now() > cooldownNotifiedUntil) {
        cooldownNotifiedUntil = aiHostDownUntil || (Date.now() + 20000);
        makeToast('AI cooling down… will retry soon');
      }
      return;
    }
    if (settings.aiMode && msg) {
      makeToast(`AI failed: ${msg}`);
    } else {
      makeToast('Upscale failed');
    }
  } finally {
    busy = false;
  }
}

// ---------- Auto mode ----------
function startAuto(){
  if (observerStarted) return;
  observerStarted = true;

  const onTick = () => {
    if (busy) return;
    if (!settings.enabled || !settings.autoPanel || !hostAllowed()) return;
    // Don't spam: only run if current visible image not yet processed
    const img = findBestVisibleImage();
    if (!img) return;
    if (img.dataset.muUpscaled === '1') return;
    // run in background
    processOnce(false);
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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SETTINGS_UPDATED') {
    loadSettings().then(()=>{
      if (!settings.enabled || !hostAllowed() || !settings.aiMode) {
        maybeStopHost('settings_update');
      } else {
        maybeStartHost('settings_update');
      }
    }).catch(()=>{});
  }
  if (msg?.type === 'RUN_ONCE') {
    processOnce(!!msg.preload, true);
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

  if (settings.aiMode && settings.enabled) {
    maybeStartHost('init');
  }

  startAuto();
  log('Ready', { host: location.hostname, enabled: settings.enabled });
})();
