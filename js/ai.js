import {OCR_PROMPT, PROVIDER_DEFAULTS} from './config.js';
import {settings, saveSettings} from './store.js';
import {$, esc} from './util.js';
import {saveProfileToDrive} from './drive.js';

const modelsCache = {};

export async function persistAiToProfile() {
  await saveSettings();
  try { await saveProfileToDrive(); } catch (e) {}
}

export function openaiV1Root(base) {
  let u = (base || '').trim();
  if (!u) throw new Error('Enter the API base URL');
  if (!/^https?:\/\//i.test(u)) throw new Error('API URL must start with http:// or https://');
  return u.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}
export function chatCompletionsUrl(base) { return openaiV1Root(base) + '/chat/completions'; }

function providerModelsUrl(provider, apiBase) {
  if (provider === 'openai') return 'https://api.openai.com/v1/models';
  if (provider === 'qwen') return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models';
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1/models';
  if (provider === 'custom') return openaiV1Root(apiBase) + '/models';
  throw new Error('Unknown provider');
}
function parseModelsList(json) {
  let rows = [];
  if (json && Array.isArray(json.data)) rows = json.data;
  else if (json && Array.isArray(json.models)) rows = json.models;
  else if (Array.isArray(json)) rows = json;
  const seen = {};
  const ids = rows.map(r => typeof r === 'string' ? r : (r && (r.id || r.name || r.model || '')))
    .map(s => String(s).trim()).filter(Boolean)
    .filter(id => { if (seen[id]) return false; seen[id] = 1; return true; });
  ids.sort((a, b) => {
    const rank = id => {
      const s = id.toLowerCase();
      return (/vision|vl-|gpt-4o|4o-mini|omni|gpt-4\.1/.test(s) ? '0' : '1') + s;
    };
    const ka = rank(a), kb = rank(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return ids;
}
export async function listProviderModels(provider, apiKey, apiBase) {
  if (!apiKey) throw new Error('Paste an API key first');
  const url = providerModelsUrl(provider, apiBase);
  const res = await fetch(url, {headers: {Authorization: 'Bearer ' + apiKey}});
  if (!res.ok) {
    let extra = '';
    try { const t = await res.text(); const j = JSON.parse(t); extra = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
    throw new Error('Could not list models (' + res.status + (extra ? ': ' + String(extra).slice(0, 100) : '') + ')');
  }
  return parseModelsList(await res.json());
}

export function providerConfig() {
  const p = settings.provider;
  if (p === 'openai') return {url: 'https://api.openai.com/v1/chat/completions', model: settings.model || 'gpt-4o', auth: 'Bearer ' + settings.apiKey};
  if (p === 'qwen') return {url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', model: settings.model || 'qwen-vl-max', auth: 'Bearer ' + settings.apiKey};
  if (p === 'deepseek') return {url: 'https://api.deepseek.com/v1/chat/completions', model: settings.model || 'deepseek-chat', auth: 'Bearer ' + settings.apiKey};
  if (p === 'custom') {
    const model = (settings.model || '').trim();
    if (!model) throw new Error('Enter a model name for the custom API');
    return {url: chatCompletionsUrl(settings.apiBase), model, auth: 'Bearer ' + settings.apiKey};
  }
  throw new Error('Unknown provider');
}

export async function callVisionOCR(dataUrl) {
  const cfg = providerConfig();
  const body = {
    model: cfg.model,
    messages: [{role: 'user', content: [
      {type: 'text', text: OCR_PROMPT},
      {type: 'image_url', image_url: {url: dataUrl}}
    ]}],
    max_tokens: 400,
    temperature: 0
  };
  const res = await fetch(cfg.url, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: cfg.auth}, body: JSON.stringify(body)});
  if (!res.ok) {
    let extra = '';
    try { const t = await res.text(); const j = JSON.parse(t); extra = (j.error && (j.error.message || j.error)) || ''; } catch (e) {}
    throw new Error('API ' + res.status + (extra ? ': ' + String(extra).slice(0, 140) : ''));
  }
  const json = await res.json();
  let txt = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) txt = m[0];
  return JSON.parse(txt);
}

export function providerOptionsHtml() {
  return [['openai', 'OpenAI'], ['qwen', 'Qwen-VL'], ['deepseek', 'DeepSeek'], ['custom', 'Custom (OpenAI-compatible)']].map(o =>
    '<option value="' + o[0] + '"' + (settings.provider === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'
  ).join('');
}
export function modelPickerHtml(ns) {
  return '<div class="field" style="margin-top:10px"><label id="' + ns + '-model-label">Model</label>' +
    '<input id="' + ns + '-model-filter" class="model-filter" placeholder="Filter models…" autocomplete="off" style="display:none">' +
    '<div class="model-row"><select id="' + ns + '-model"><option value="">Paste key, then load models</option></select>' +
    '<button type="button" class="set-btn" id="' + ns + '-models-refresh">Load</button></div>' +
    '<input id="' + ns + '-model-other" placeholder="Type a model name" autocomplete="off" style="display:none;margin-top:8px">' +
    '<p class="field-hint" id="' + ns + '-models-status">Paste your API key, then tap Load to browse models from the API.</p></div>';
}
export function readModelValue(ns) {
  const sel = $(ns + '-model'), other = $(ns + '-model-other');
  if (!sel) return '';
  if (sel.value === '__other__') return other ? (other.value || '').trim() : '';
  return (sel.value || '').trim();
}
export function wireModelPicker(ns, customWrapId) {
  const providerEl = $(ns + '-provider'), keyEl = $(ns + '-key'), baseEl = $(ns + '-base');
  const modelEl = $(ns + '-model'), otherEl = $(ns + '-model-other'), filterEl = $(ns + '-model-filter');
  const statusEl = $(ns + '-models-status'), refreshEl = $(ns + '-models-refresh');
  const labelEl = $(ns + '-model-label'), wrap = $(customWrapId);
  if (!modelEl) return;
  let loadSeq = 0;
  function snap() {
    return {
      provider: providerEl ? providerEl.value : settings.provider,
      apiKey: keyEl ? (keyEl.value || '').trim() : (settings.apiKey || ''),
      apiBase: baseEl ? (baseEl.value || '').trim() : (settings.apiBase || '')
    };
  }
  function cacheKey(s) { return s.provider + '|' + (s.apiBase || '') + '|' + (s.apiKey || ''); }
  function syncCustom() {
    const c = providerEl && providerEl.value === 'custom';
    if (wrap) wrap.style.display = c ? '' : 'none';
    if (labelEl) labelEl.classList.toggle('req', !!c);
  }
  function syncOther() {
    const show = modelEl.value === '__other__';
    if (otherEl) otherEl.style.display = show ? 'block' : 'none';
  }
  function renderOptions(list, currentModel) {
    const s = snap();
    const def = PROVIDER_DEFAULTS[s.provider];
    const have = {};
    let html = def ? '<option value="">Default — ' + esc(def) + '</option>' : '<option value="">Select a model</option>';
    (list || []).forEach(id => { have[id] = 1; html += '<option value="' + esc(id) + '">' + esc(id) + '</option>'; });
    if (currentModel && !have[currentModel] && currentModel !== '__other__') html += '<option value="' + esc(currentModel) + '">' + esc(currentModel) + '</option>';
    html += '<option value="__other__">Other…</option>';
    modelEl.innerHTML = html;
    if (currentModel) {
      modelEl.value = currentModel;
      if (modelEl.value !== currentModel) { modelEl.value = '__other__'; if (otherEl) otherEl.value = currentModel; }
    } else modelEl.value = '';
    syncOther();
  }
  function paint(all, currentModel, note, err) {
    modelEl._allModels = all || [];
    const q = filterEl ? (filterEl.value || '').trim().toLowerCase() : '';
    const shown = q ? modelEl._allModels.filter(id => id.toLowerCase().indexOf(q) >= 0) : modelEl._allModels;
    renderOptions(shown, currentModel);
    if (filterEl) filterEl.style.display = modelEl._allModels.length > 20 ? 'block' : 'none';
    if (statusEl) {
      statusEl.textContent = note || (modelEl._allModels.length ? modelEl._allModels.length + ' models' : 'Paste your API key, then tap Load.');
      statusEl.classList.toggle('err', !!err);
    }
  }
  async function load(force) {
    const s = snap();
    if (s.provider === 'custom' && !s.apiBase) { paint(modelEl._allModels || [], readModelValue(ns), 'Enter the API base URL, then tap Load.', true); return; }
    if (!s.apiKey) { paint(modelEl._allModels || [], readModelValue(ns), 'Paste your API key, then tap Load.', true); return; }
    const ck = cacheKey(s);
    if (!force && modelsCache[ck]) { paint(modelsCache[ck], readModelValue(ns) || settings.model, modelsCache[ck].length + ' models'); return; }
    const seq = ++loadSeq;
    if (statusEl) { statusEl.textContent = 'Loading models…'; statusEl.classList.remove('err'); }
    if (refreshEl) { refreshEl.disabled = true; refreshEl.textContent = '…'; }
    try {
      const models = await listProviderModels(s.provider, s.apiKey, s.apiBase);
      if (seq !== loadSeq) return;
      modelsCache[ck] = models;
      settings.models = models;
      paint(models, readModelValue(ns) || settings.model, models.length ? (models.length + ' models saved to your profile') : 'API returned no models');
      persistAiToProfile();
    } catch (e) {
      if (seq !== loadSeq) return;
      const msg = /failed to fetch|networkerror|load failed/i.test(String(e.message || e))
        ? 'Could not reach /v1/models from this browser. Choose Other… and type the model name.'
        : (e.message || 'Could not list models');
      paint(modelEl._allModels || [], readModelValue(ns) || settings.model, msg, true);
    }
    if (refreshEl) { refreshEl.disabled = false; refreshEl.textContent = 'Load'; }
  }
  if (providerEl) providerEl.addEventListener('change', () => { syncCustom(); load(true); });
  if (keyEl) { keyEl.addEventListener('change', () => load(true)); keyEl.addEventListener('paste', () => setTimeout(() => load(true), 50)); }
  if (baseEl) baseEl.addEventListener('change', () => load(true));
  modelEl.addEventListener('change', syncOther);
  if (filterEl) filterEl.addEventListener('input', () => paint(modelEl._allModels || [], readModelValue(ns)));
  if (refreshEl) refreshEl.onclick = () => load(true);
  const saved = Array.isArray(settings.models) ? settings.models : [];
  const initial = settings.model || '';
  if (saved.length) {
    modelsCache[cacheKey(snap())] = saved;
    paint(saved, initial, saved.length + ' models saved in your profile');
  } else {
    paint(initial ? [initial] : [], initial, 'Paste your API key, then tap Load to browse models from the API.');
  }
  syncCustom();
  if (!saved.length && snap().apiKey && (snap().provider !== 'custom' || snap().apiBase)) load(false);
}
