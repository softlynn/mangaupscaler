const DEFAULTS = {
  enabled: true,
  autoPanel: true,
  scale: 3,
  preUpscaleCount: 3,
  whitelist: {}, // { "example.com": true }
  showToast: true,
  aiQuality: 'balanced'
};

const $ = (id) => document.getElementById(id);

const enabledToggle = $('enabledToggle');
const autoToggle = $('autoToggle');
const siteToggle = $('siteToggle');
const scale = $('scale');
const pre = $('pre');
const preN = $('preN');
const run = $('run');
const runPrimary = $('runPrimary');

const siteLink = $('siteLink');
const supportLink = $('supportLink');
const openSettings = $('openSettings');
const aiQuality = $('aiQuality');
const siteStatus = $('siteStatus');
const preStatus = $('preStatus');

let currentHost = null;
let siteLocked = false;

function isHostAllowed(host, whitelist){
  if (!host) return false;
  const wh = whitelist || {};
  const any = Object.keys(wh).length > 0;
  if (!any) {
    return (host === 'comix.to' || host === 'weebcentral.com' || host.endsWith('.weebcentral.com'));
  }
  return !!wh[host];
}

function setControlDisabled(el, on){
  if (!el) return;
  el.disabled = !!on;
  el.classList.toggle('controlDisabled', !!on);
}

function setRowDisabled(el, on){
  if (!el) return;
  const row = el.closest('.row');
  if (row) row.classList.toggle('controlDisabled', !!on);
}

function applySiteLock(allowed){
  siteLocked = !allowed;
  [enabledToggle, autoToggle].forEach(t => t.classList.toggle('locked', siteLocked));
  [scale, pre, aiQuality].forEach(el => setControlDisabled(el, siteLocked || !getToggle(enabledToggle)));
  if (siteLocked){
    setToggle(enabledToggle, false);
    if (siteStatus) siteStatus.textContent = 'Disabled on this site. Toggle "Only on this site" to enable.';
  } else if (siteStatus) {
    siteStatus.textContent = '';
  }
}

function applyEnabledState(on){
  const isOn = !!on;
  setControlDisabled(aiQuality, siteLocked || !isOn);
  setControlDisabled(scale, siteLocked || !isOn);
  setControlDisabled(pre, siteLocked || !isOn);
  [run, runPrimary].forEach(btn => { if (btn) btn.disabled = siteLocked || !isOn; });
}

function setToggle(el, on){
  el.classList.toggle('on', !!on);
}
function getToggle(el){ return el.classList.contains('on'); }

async function getActiveTab(){
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  return tab;
}

async function load(){
  const s = await chrome.storage.sync.get(DEFAULTS);
  const tab = await getActiveTab();
  currentHost = (tab?.url ? new URL(tab.url).hostname : null);

  setToggle(enabledToggle, !!s.enabled);
  setToggle(autoToggle, !!s.autoPanel);
  scale.value = String(s.scale ?? 3);
  aiQuality.value = String(s.aiQuality ?? 'balanced');

  pre.value = String(s.preUpscaleCount ?? 0);
  preN.textContent = String(s.preUpscaleCount ?? 0);
  runPrimary.textContent = `Enhance + Preload ${Number(s.preUpscaleCount ?? 0)}`;

  const wh = s.whitelist || {};
  const siteOn = currentHost ? !!wh[currentHost] : false;
  setToggle(siteToggle, siteOn);
  const allowed = isHostAllowed(currentHost, wh);
  applySiteLock(allowed);
  applyEnabledState(!!s.enabled);
  refreshPreStatus().catch(()=>{});

  siteLink.addEventListener('click', (e)=>{ e.preventDefault(); chrome.tabs.create({url:'https://softlynn.carrd.co/#'}); });
  openSettings.addEventListener('click', ()=>{
  chrome.runtime.openOptionsPage();
});

supportLink.addEventListener('click', (e)=>{ e.preventDefault(); chrome.tabs.create({url:'https://www.paypal.com/paypalme/softlynn'}); });
}

async function save(patch){
  const s = await chrome.storage.sync.get(DEFAULTS);
  const next = { ...s, ...patch };
  await chrome.storage.sync.set(next);
}

async function sendCommand(cmd){
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, cmd).catch(()=>{});
}

async function refreshPreStatus(){
  try{
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PRELOAD_STATUS' }).catch(()=>null);
    if (!preStatus) return;
    if (!resp || typeof resp !== 'object') { preStatus.textContent = ''; return; }
    const t = Number(resp.target || 0);
    const p = Number(resp.preloaded || 0);
    const f = Number(resp.prefetched || 0);
    if (t <= 0) { preStatus.textContent = ''; return; }
    preStatus.textContent = `Preloaded ahead: ${p}/${t}  •  Page prefetched: ${f}/${t}`;
  } catch {
    if (preStatus) preStatus.textContent = '';
  }
}

enabledToggle.addEventListener('click', async ()=>{
  if (siteLocked) return;
  const on = !getToggle(enabledToggle);
  setToggle(enabledToggle, on);
  await save({enabled:on});
  await sendCommand({type:'SETTINGS_UPDATED'});
  if (!on) {
    await sendCommand({type:'HOST_STOP', reason:'disabled'});
  } else {
    await sendCommand({type:'HOST_START', reason:'enabled'});
  }
  applyEnabledState(on);
});

autoToggle.addEventListener('click', async ()=>{
  if (siteLocked) return;
  const on = !getToggle(autoToggle);
  setToggle(autoToggle, on);
  await save({autoPanel:on});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

siteToggle.addEventListener('click', async ()=>{
  if (!currentHost) return;
  const s = await chrome.storage.sync.get(DEFAULTS);
  const wh = {...(s.whitelist||{})};
  const on = !wh[currentHost];
  wh[currentHost] = on;
  setToggle(siteToggle, on);
  await save({whitelist: wh});
  await sendCommand({type:'SETTINGS_UPDATED'});
  applySiteLock(isHostAllowed(currentHost, wh));
});

aiQuality.addEventListener('change', async ()=>{
  if (siteLocked) return;
  await save({ aiQuality: String(aiQuality.value) });
  await sendCommand({ type:'SETTINGS_UPDATED' });
});

scale.addEventListener('change', async ()=>{
  if (siteLocked) return;
  await save({scale: Number(scale.value)});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

pre.addEventListener('input', async ()=>{
  if (siteLocked) return;
  preN.textContent = pre.value;
  runPrimary.textContent = `Enhance + Preload ${Number(pre.value)}`;
  await save({preUpscaleCount: Number(pre.value)});
  await sendCommand({type:'SETTINGS_UPDATED'});
  refreshPreStatus().catch(()=>{});
});

run.addEventListener('click', async ()=>{
  if (siteLocked) return;
  await sendCommand({type:'RUN_ONCE', preload:false});
  window.close();
});

runPrimary.addEventListener('click', async ()=>{
  if (siteLocked) return;
  await sendCommand({type:'RUN_ONCE', preload:true});
  window.close();
});

load().catch(console.error);
