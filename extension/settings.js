
const DEFAULTS = {
  enabled: true,
  autoPanel: true,
  scale: 3,
  preUpscaleCount: 1,
  sharpenStrength: 0.40,
  denoiseStrength: 0.15,
  whitelist: {},
  showToast: true,
  watermark: true,
  aiMode: false,
  aiQuality: 'balanced',
  allowDat2: false,
  cacheMaxGb: 1.0,
  cacheMaxAgeDays: 0,
  idleShutdownMinutes: 5
};

const POPULAR = [
  { d: 'comix.to', note: 'Comix' },
  { d: 'weebcentral.com', note: 'WeebCentral' },
  { d: 'mangadex.org', note: 'MangaDex' },
  { d: 'mangareader.to', note: 'MangaReader' },
  { d: 'manganato.com', note: 'Manganato' },
  { d: 'mangakakalot.com', note: 'MangaKakalot' },
  { d: 'bato.to', note: 'Bato.to' },
  { d: 'manga4life.com', note: 'Manga4Life' },
  { d: 'manga4life.net', note: 'Manga4Life mirror' },
  { d: 'mangasee123.com', note: 'MangaSee' },
  { d: 'readm.org', note: 'ReadM' },
  { d: 'mangago.me', note: 'MangaGo' },
  { d: 'asuracomic.net', note: 'Asura' },
  { d: 'reaperscans.com', note: 'Reaper Scans' },
  { d: 'flamecomics.com', note: 'Flame' },
  { d: 'zeroscans.com', note: 'Zero Scans' },
  { d: 'toongod.org', note: 'ToonGod' }
];

const $ = (id)=>document.getElementById(id);

function setToggle(el,on){ el.classList.toggle('on', !!on); }
function getToggle(el){ return el.classList.contains('on'); }

async function loadSettings(){
  const s = await chrome.storage.sync.get(null);
  return { ...DEFAULTS, ...s, whitelist: { ...(DEFAULTS.whitelist||{}), ...(s.whitelist||{}) } };
}

async function saveSettings(s){
  await chrome.storage.sync.set(s);
}

function normDomain(v){
  v = (v||'').trim().toLowerCase();
  v = v.replace(/^https?:\/\//,'').replace(/^www\./,'');
  v = v.split('/')[0];
  return v;
}

function renderWhitelist(wl, filterText){
  const list = $('whitelistList');
  list.innerHTML = '';
  const f = (filterText||'').trim().toLowerCase();

  // Merge popular + custom keys
  const merged = new Map();
  for (const p of POPULAR) merged.set(p.d, p.note);
  for (const d of Object.keys(wl||{})) if (!merged.has(d)) merged.set(d, 'Custom');

  const domains = Array.from(merged.keys()).sort((a,b)=>a.localeCompare(b));
  for (const d of domains){
    if (f && !d.includes(f)) continue;
    const enabled = !!wl[d];

    const row = document.createElement('div');
    row.className = 'wlItem';
    row.innerHTML = `
      <div>
        <div class="domain">${d}</div>
        <div class="tag">${merged.get(d) || ''}</div>
      </div>
      <div class="toggle ${enabled?'on':''}" data-domain="${d}"><div class="knob"></div></div>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll('.toggle[data-domain]').forEach(t=>{
    t.addEventListener('click', ()=>{
      const d = t.getAttribute('data-domain');
      const on = !t.classList.contains('on');
      t.classList.toggle('on', on);
    });
  });
}

async function readUIIntoSettings(){
  const s = await loadSettings();
  s.enabled = getToggle($('enabled'));
  s.autoPanel = getToggle($('autoPanel'));
  s.aiMode = getToggle($('aiMode'));
  s.allowDat2 = getToggle($('allowDat2'));
  s.aiQuality = String($('aiQuality')?.value || s.aiQuality || 'balanced');
  s.scale = Number($('scale').value) || 3;
  s.preUpscaleCount = Number($('preUpscaleCount').value) || 0;
  s.sharpenStrength = Number($('sharpenStrength').value) || 0;
  s.denoiseStrength = Number($('denoiseStrength').value) || 0;
  s.cacheMaxGb = Number($('cacheMaxGb').value) || 0;
  s.cacheMaxAgeDays = Number($('cacheMaxAgeDays').value) || 0;
  s.idleShutdownMinutes = Number($('idleShutdownMinutes').value) || 0;

  // whitelist: read toggles in list
  const wl = { ...(s.whitelist||{}) };
  document.querySelectorAll('.toggle[data-domain]').forEach(t=>{
    wl[t.getAttribute('data-domain')] = t.classList.contains('on');
  });
  s.whitelist = wl;
  return s;
}

function bindRanges(){
  const pre = $('preUpscaleCount');
  const preVal = $('preVal');
  const sh = $('sharpenStrength');
  const shVal = $('sharpenVal');
  const dn = $('denoiseStrength');
  const dnVal = $('denoiseVal');

  const upd = ()=>{
    preVal.textContent = `${pre.value} page(s)`;
    shVal.textContent = Number(sh.value).toFixed(2);
    dnVal.textContent = Number(dn.value).toFixed(2);
  };
  [pre,sh,dn].forEach(x=>x.addEventListener('input', upd));
  upd();
}

function bindCacheInputs(){
  const maxGb = $('cacheMaxGb');
  const maxGbVal = $('cacheMaxGbVal');
  const maxDays = $('cacheMaxAgeDays');
  const maxDaysVal = $('cacheMaxAgeDaysVal');
  const idleMin = $('idleShutdownMinutes');
  const idleVal = $('idleShutdownMinutesVal');
  if (!maxGb || !maxDays || !idleMin) return;

  const upd = () => {
    const gb = Number(maxGb.value);
    const days = Number(maxDays.value);
    if (maxGbVal) {
      maxGbVal.textContent = (Number.isFinite(gb) && gb > 0) ? `${gb.toFixed(1)} GB` : '0 = off';
    }
    if (maxDaysVal) {
      maxDaysVal.textContent = (Number.isFinite(days) && days > 0) ? `${days} day(s)` : '0 = off';
    }
    if (idleVal) {
      const mins = Number(idleMin.value);
      idleVal.textContent = (Number.isFinite(mins) && mins > 0) ? `${mins} min` : '0 = off';
    }
  };
  [maxGb, maxDays, idleMin].forEach(x=>x.addEventListener('input', upd));
  upd();
}

async function init(){
  const s = await loadSettings();

  setToggle($('enabled'), s.enabled);
  setToggle($('autoPanel'), s.autoPanel);
  setToggle($('aiMode'), s.aiMode);
  setToggle($('allowDat2'), s.allowDat2);
  $('aiQuality').value = String(s.aiQuality || 'balanced');

  $('scale').value = String(s.scale||3);

  $('preUpscaleCount').value = String(s.preUpscaleCount||0);
  $('sharpenStrength').value = String(s.sharpenStrength||0);
  $('denoiseStrength').value = String(s.denoiseStrength||0);
  $('cacheMaxGb').value = String(s.cacheMaxGb ?? 1.0);
  $('cacheMaxAgeDays').value = String(s.cacheMaxAgeDays ?? 0);
  $('idleShutdownMinutes').value = String(s.idleShutdownMinutes ?? 5);

  bindRanges();
  bindCacheInputs();

  renderWhitelist(s.whitelist, '');
  $('filter').addEventListener('input', async ()=>{
    const s2 = await loadSettings();
    renderWhitelist(s2.whitelist, $('filter').value);
  });

  // toggle blocks
  ['enabled','autoPanel','aiMode','allowDat2'].forEach(id=>{
    $(id).addEventListener('click', ()=>$(id).classList.toggle('on'));
  });

  $('addDomain').addEventListener('click', async ()=>{
    const d = normDomain($('customDomain').value);
    if (!d) return;
    const s2 = await loadSettings();
    s2.whitelist[d] = true;
    await saveSettings(s2);
    $('customDomain').value = '';
    renderWhitelist(s2.whitelist, $('filter').value);
  });

  $('saveBtn').addEventListener('click', async ()=>{
    const out = await readUIIntoSettings();
    await saveSettings(out);
    // let content scripts refresh quickly
    chrome.runtime.sendMessage({ type:'SETTINGS_UPDATED' }).catch(()=>{});
    if (out.aiMode) {
      chrome.runtime.sendMessage({
        type:'HOST_CONFIG',
        cacheMaxGb: out.cacheMaxGb,
        cacheMaxAgeDays: out.cacheMaxAgeDays,
        allowDat2: out.allowDat2,
        idleShutdownMinutes: out.idleShutdownMinutes
      }).catch(()=>{});
    } else {
      chrome.runtime.sendMessage({ type:'HOST_STOP', reason:'ai_mode_off' }).catch(()=>{});
    }
    $('saveBtn').textContent = 'Saved!';
    setTimeout(()=> $('saveBtn').textContent = 'Save', 900);
  });

  $('clearCache').addEventListener('click', async ()=>{
    const btn = $('clearCache');
    btn.textContent = 'Clearing...';
    await chrome.runtime.sendMessage({ type:'HOST_CLEAR_CACHE' }).catch(()=>{});
    btn.textContent = 'Clear cache';
  });

  $('downloadModels').addEventListener('click', async ()=>{
    const btn = $('downloadModels');
    btn.textContent = 'Downloading...';
    const allowDat2 = getToggle($('allowDat2'));
    await chrome.runtime.sendMessage({ type:'HOST_DOWNLOAD_MODELS', allowDat2 }).catch(()=>{});
    btn.textContent = 'Download';
  });
}

init().catch(console.error);
