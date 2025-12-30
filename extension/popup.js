const DEFAULTS = {
  enabled: true,
  autoPanel: true,
  scale: 3,
  preUpscaleCount: 1,
  sharpenStrength: 0.40,
  denoiseStrength: 0.15,
  whitelist: {}, // { "example.com": true }
  showToast: true,
  watermark: true,
  aiMode: false,
  aiQuality: 'balanced'
};

const $ = (id) => document.getElementById(id);

const enabledToggle = $('enabledToggle');
const autoToggle = $('autoToggle');
const siteToggle = $('siteToggle');
const scale = $('scale');
const pre = $('pre');
const preN = $('preN');
const sharp = $('sharp');
const sharpVal = $('sharpVal');
const denoise = $('denoise');
const dnVal = $('dnVal');
const run = $('run');
const runPrimary = $('runPrimary');

const credits = $('credits');
const secretDot = $('secretDot');
const siteLink = $('siteLink');
const supportLink = $('supportLink');
const openSettings = $('openSettings');
const aiMode = $('aiMode');
const aiQuality = $('aiQuality');

let currentHost = null;

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
  setToggle(aiMode, !!s.aiMode);
  scale.value = String(s.scale ?? 3);
  aiQuality.value = String(s.aiQuality ?? 'balanced');

  pre.value = String(s.preUpscaleCount ?? 0);
  preN.textContent = String(s.preUpscaleCount ?? 0);

  sharp.value = String(s.sharpenStrength ?? 0.4);
  sharpVal.textContent = Number(s.sharpenStrength ?? 0.4).toFixed(2);

  denoise.value = String(s.denoiseStrength ?? 0.15);
  dnVal.textContent = Number(s.denoiseStrength ?? 0.15).toFixed(2);

  const wh = s.whitelist || {};
  const siteOn = currentHost ? !!wh[currentHost] : false;
  setToggle(siteToggle, siteOn);

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

enabledToggle.addEventListener('click', async ()=>{
  const on = !getToggle(enabledToggle);
  setToggle(enabledToggle, on);
  await save({enabled:on});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

autoToggle.addEventListener('click', async ()=>{
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
});

aiMode.addEventListener('click', async ()=>{
  const on = !getToggle(aiMode);
  setToggle(aiMode, on);
  await save({ aiMode: on });
  await sendCommand({ type:'SETTINGS_UPDATED' });
});

aiQuality.addEventListener('change', async ()=>{
  await save({ aiQuality: String(aiQuality.value) });
  await sendCommand({ type:'SETTINGS_UPDATED' });
});

scale.addEventListener('change', async ()=>{
  await save({scale: Number(scale.value)});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

pre.addEventListener('input', async ()=>{
  preN.textContent = pre.value;
  await save({preUpscaleCount: Number(pre.value)});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

sharp.addEventListener('input', async ()=>{
  sharpVal.textContent = Number(sharp.value).toFixed(2);
  await save({sharpenStrength: Number(sharp.value)});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

denoise.addEventListener('input', async ()=>{
  dnVal.textContent = Number(denoise.value).toFixed(2);
  await save({denoiseStrength: Number(denoise.value)});
  await sendCommand({type:'SETTINGS_UPDATED'});
});

run.addEventListener('click', async ()=>{
  await sendCommand({type:'RUN_ONCE', preload:false});
  window.close();
});

runPrimary.addEventListener('click', async ()=>{
  await sendCommand({type:'RUN_ONCE', preload:true});
  window.close();
});

// Secret credits: click the dot 7 times
secretDot.addEventListener('click', ()=>{
  credits.classList.toggle('show');
});
load().catch(console.error);
