// Manga Upscaler content script (v1.4)
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
  aiMode: false
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
let lastProcessedUrl = null;
let observerStarted = false;
let aiHostDownUntil = 0;

// ---------- Settings ----------
async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...s, whitelist: s.whitelist || {} };
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

function makeToast(text){
  if (!settings.showToast) return;
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = `
    position: fixed; left: 18px; bottom: 18px; z-index: 2147483647;
    background: rgba(20,18,24,.92); color: #fff; border: 1px solid rgba(255,255,255,.18);
    padding: 10px 12px; border-radius: 14px; font: 12px/1.2 system-ui;
    box-shadow: 0 16px 40px rgba(0,0,0,.35); backdrop-filter: blur(8px);
    pointer-events: none;
  `;
  (document.body || document.documentElement).appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s ease'; }, 1600);
  setTimeout(()=>el.remove(), 2000);
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

// Pick the "panel in view": largest visible <img> by viewport intersection area.
function findBestVisibleImage(){
  const imgs = Array.from(document.images || []);
  const vw = window.innerWidth, vh = window.innerHeight;
  let best = null;
  let bestScore = 0;

  for (const img of imgs){
    if (!img || !img.src) continue;
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
  if (url.startsWith('data:')) return url;

  // Ask background to fetch, avoids CORS taint.
  const resp = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_DATAURL', url, pageUrl: location.href });
  if (!resp?.ok) throw new Error(resp?.error || 'Failed to fetch');
  return resp.dataUrl;
}

function loadImage(dataUrl){
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Image decode failed'));
    im.src = dataUrl;
  });
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

async function enhanceViaHost(srcUrl){
  if (!srcUrl) throw new Error('Missing image url');
  const rawScale = clamp(Number(settings.scale || 3), 2, 4);
  const scale = rawScale <= 2 ? 2 : 4;
  const quality = String(settings.aiQuality || 'balanced');
  if (Date.now() < aiHostDownUntil) throw new Error('AI host cooldown');

  let resp;
  if (srcUrl.startsWith('data:') || srcUrl.startsWith('blob:')) {
    const dataUrl = await fetchImageAsDataURL(srcUrl);
    resp = await chrome.runtime.sendMessage({
      type: 'FETCH_AI_ENHANCE',
      dataUrl,
      scale,
      quality
    });
  } else {
    resp = await chrome.runtime.sendMessage({
      type: 'FETCH_AI_ENHANCE',
      sourceUrl: srcUrl,
      scale,
      quality
    });
  }

  if (!resp?.ok) {
    aiHostDownUntil = Date.now() + 20000;
    throw new Error(resp?.error || 'AI host not available');
  }
  if (resp.hostError) {
    throw new Error(resp.hostError);
  }
  return { dataUrl: resp.dataUrl, model: resp.model || '' };
}

// ---------- Replace in page ----------
function replaceImgSrc(imgEl, dataUrl){
  const rect = imgEl.getBoundingClientRect();
  const hasSizing = !!(imgEl.style.width || imgEl.style.height || imgEl.getAttribute('width') || imgEl.getAttribute('height'));
  if (!imgEl.dataset.muStyleWidth) {
    imgEl.dataset.muStyleWidth = imgEl.style.width || '';
  }
  if (!imgEl.dataset.muStyleHeight) {
    imgEl.dataset.muStyleHeight = imgEl.style.height || '';
  }
  if (!hasSizing && rect.width > 0 && rect.height > 0) {
    imgEl.style.width = `${Math.round(rect.width)}px`;
    imgEl.style.height = `${Math.round(rect.height)}px`;
    imgEl.style.objectFit = 'contain';
  }
  imgEl.dataset.muOriginalSrc = imgEl.dataset.muOriginalSrc || imgEl.src;
  imgEl.src = dataUrl;
  imgEl.style.imageRendering = 'auto';
}

function getNextCandidateImages(currentImg, n){
  if (n <= 0) return [];
  const imgs = Array.from(document.images || []).filter(i => i && i.src && i !== currentImg);
  // Prefer those near/below the current image
  const curTop = currentImg.getBoundingClientRect().top + window.scrollY;
  const scored = imgs.map(i=>{
    const top = i.getBoundingClientRect().top + window.scrollY;
    return { i, d: Math.abs(top - curTop), below: top >= curTop ? 0 : 1 };
  }).sort((a,b)=> (a.below - b.below) || (a.d - b.d));
  return scored.slice(0, n).map(x=>x.i);
}

async function processImageElement(imgEl){
  const src = imgEl.currentSrc || imgEl.src;
  if (!src) return;

  if (src === lastProcessedUrl) return; // avoid loops
  lastProcessedUrl = src;

  // If already upscaled by us, skip
  if (imgEl.dataset.muUpscaled === '1') return;

  const rect = imgEl.getBoundingClientRect();
  sparkle(rect);

  let out;
  let model = '';
  if (settings.aiMode) {
    const ai = await enhanceViaHost(src);
    out = ai.dataUrl;
    model = ai.model;
  } else {
    const data = await fetchImageAsDataURL(src);
    out = await enhanceToDataURL(data);
  }

  replaceImgSrc(imgEl, out);
  imgEl.dataset.muUpscaled = '1';

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

  if (busy) return;
  busy = true;
  try{
    if (showStatus){
      makeToast(preload ? 'Enhancing + preload...' : 'Enhancing...');
    }
    const img = findBestVisibleImage();
    if (!img) { makeToast('No panel found'); return; }

    await processImageElement(img);

    if (preload){
      const next = getNextCandidateImages(img, clamp(Number(settings.preUpscaleCount||0), 0, 4));
      for (const ni of next){
        try{
          await processImageElement(ni);
        }catch(e){
          // ignore per-item
        }
      }
    }
  } catch(e){
    log('Enhance failed:', e);
    const msg = String(e?.message || e || '').slice(0, 120);
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
    if (!settings.enabled || !settings.autoPanel || !hostAllowed()) return;
    // Don’t spam: only run if current visible image not yet processed
    const img = findBestVisibleImage();
    if (!img) return;
    if (img.dataset.muUpscaled === '1') return;
    // run in background
    processOnce(false);
  };

  let t = null;
  const schedule = () => {
    clearTimeout(t);
    t = setTimeout(onTick, 220);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  // DOM changes (lazy-loaded pages)
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  schedule();
}

// ---------- Messaging ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SETTINGS_UPDATED') {
    loadSettings().then(()=>{ /* re-eval */ }).catch(()=>{});
  }
  if (msg?.type === 'RUN_ONCE') {
    processOnce(!!msg.preload, true);
  }
});

// ---------- Boot ----------
(async function init(){
  await loadSettings();

  if (!hostAllowed()) return; // no work on non-whitelisted sites

  startAuto();
  log('Ready', { host: location.hostname, enabled: settings.enabled });
})();
