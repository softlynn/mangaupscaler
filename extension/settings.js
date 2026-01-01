
const DEFAULTS = {
  enabled: true,
  autoPanel: true,
  scale: 3,
  preUpscaleCount: 3,
  whitelist: {},
  showToast: true,
  aiQuality: 'balanced',
  allowDat2: false,
  cacheMaxGb: 1.0,
  cacheMaxAgeDays: 0,
  idleShutdownMinutes: 5,
  telemetryEnabled: true,
  telemetryUploadUrl: 'https://script.google.com/macros/s/AKfycbzva5kasl0U0QgZc8tAFzcbERqdL98S8rjRdjY8by4C8yINApPSRH3qZaU3OReknQz7/exec'
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
    const isCustom = !POPULAR.some(p => p.d === d);

    const row = document.createElement('div');
    row.className = 'wlItem';
    row.innerHTML = `
      <div>
        <div class="domain">${d}</div>
        <div class="tag">${merged.get(d) || ''}</div>
      </div>
      <div class="wlActions">
        <div class="toggle ${enabled?'on':''}" data-domain="${d}"><div class="knob"></div></div>
        ${isCustom ? `<button class="wlRemove" data-remove="${d}" title="Remove">Remove</button>` : ''}
      </div>
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

  list.querySelectorAll('.wlRemove[data-remove]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const d = btn.getAttribute('data-remove');
      if (!d) return;
      const s2 = await loadSettings();
      delete s2.whitelist[d];
      await saveSettings(s2);
      renderWhitelist(s2.whitelist, f);
    });
  });
}

async function readUIIntoSettings(){
  const s = await loadSettings();
  s.enabled = getToggle($('enabled'));
  s.autoPanel = getToggle($('autoPanel'));
  s.showToast = getToggle($('showToast'));
  s.allowDat2 = getToggle($('allowDat2'));
  s.telemetryEnabled = getToggle($('telemetryEnabled'));
  s.telemetryUploadUrl = String($('telemetryUploadUrl')?.value || '').trim();
  s.aiQuality = String($('aiQuality')?.value || s.aiQuality || 'balanced');
  s.scale = Number($('scale').value) || 3;
  s.preUpscaleCount = Number($('preUpscaleCount').value) || 0;
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

  const upd = ()=>{
    preVal.textContent = `${pre.value} page(s)`;
  };
  [pre].forEach(x=>x.addEventListener('input', upd));
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
  setToggle($('showToast'), s.showToast);
  setToggle($('allowDat2'), s.allowDat2);
  setToggle($('telemetryEnabled'), !!s.telemetryEnabled);
  if ($('telemetryUploadUrl')) $('telemetryUploadUrl').value = String(s.telemetryUploadUrl || '');
  $('aiQuality').value = String(s.aiQuality || 'balanced');

  $('scale').value = String(s.scale||3);

  $('preUpscaleCount').value = String(s.preUpscaleCount||0);
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
  ['enabled','autoPanel','showToast','allowDat2','telemetryEnabled'].forEach(id=>{
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
    chrome.runtime.sendMessage({
      type:'HOST_CONFIG',
      cacheMaxGb: out.cacheMaxGb,
      cacheMaxAgeDays: out.cacheMaxAgeDays,
      allowDat2: out.allowDat2,
      idleShutdownMinutes: out.idleShutdownMinutes
    }).catch(()=>{});
    if (!out.enabled) {
      chrome.runtime.sendMessage({ type:'TRAY_STOP', reason:'disabled' }).catch(()=>{});
    } else {
      chrome.runtime.sendMessage({ type:'TRAY_START', reason:'enabled' }).catch(()=>{});
    }
    $('saveBtn').textContent = 'Saved!';
    setTimeout(()=> $('saveBtn').textContent = 'Save', 900);
  });

  $('viewTelemetry').addEventListener('click', ()=>{
    try{
      chrome.tabs.create({ url: 'http://127.0.0.1:48159/telemetry/recent' });
    } catch {}
  });

  $('telemetryTest').addEventListener('click', async ()=>{
    const btn = $('telemetryTest');
    const out = $('telemetryTestStatus');
    if (btn) btn.textContent = 'Testing...';
    if (out) out.textContent = '';
    try{
      const resp = await chrome.runtime.sendMessage({ type:'TELEMETRY_TEST' }).catch(()=>null);
      if (!out) return;
      if (!resp) { out.textContent = 'No response (background not available).'; return; }
      if (resp.dropped) { out.textContent = 'Diagnostics are disabled. Turn on “Share anonymous diagnostics”, click Save, then retry.'; return; }
      const parts = [];
      parts.push(`Local host: ${resp.hostOk ? 'OK' : 'not running'}`);
      parts.push(`Local /telemetry/recent: ${resp.telemetryRecentOk ? 'OK' : 'not found'}`);
      if (resp.uploadUrl) parts.push(`Upload: ${resp.remoteOk ? 'OK' : 'failed'}`);
      else parts.push('Upload: (blank)');
      out.textContent = parts.join(' • ');
    } finally {
      if (btn) btn.textContent = 'Run test';
    }
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

  $('startTray').addEventListener('click', async ()=>{
    const btn = $('startTray');
    btn.textContent = 'Starting...';
    await chrome.runtime.sendMessage({ type:'TRAY_START' }).catch(()=>{});
    btn.textContent = 'Start tray';
  });

  $('stopTray').addEventListener('click', async ()=>{
    const btn = $('stopTray');
    btn.textContent = 'Stopping...';
    await chrome.runtime.sendMessage({ type:'TRAY_STOP' }).catch(()=>{});
    btn.textContent = 'Stop tray';
  });
}

init().catch(console.error);
