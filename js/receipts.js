import {settings, session} from './store.js';
import {$, toast, compressImage, extFromFile, normalizeCategory} from './util.js';
import {callVisionOCR, persistAiToProfile, readModelValue} from './ai.js';

export function ocrStatus(msg, err) {
  const el = $('m-ocr-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  el.classList.toggle('err', !!err);
}

export function clearPendingPhoto() {
  const p = session.pending;
  if (p && p.previewUrl) try { URL.revokeObjectURL(p.previewUrl); } catch (e) {}
  session.pending = null;
}

function showPreview() {
  const p = session.pending;
  const img = $('m-photo-img'), pv = $('m-photo-preview'), meta = $('m-photo-meta');
  if (!img || !pv || !p) return;
  img.src = p.previewUrl || p.thumbDataUrl || '';
  pv.classList.add('show');
  if (meta) {
    const name = (p.originalFile && p.originalFile.name) || 'Receipt photo';
    const kb = p.originalFile ? Math.max(1, Math.round(p.originalFile.size / 1024)) : 0;
    meta.textContent = kb ? ('Original photo attached · ' + name + ' · ' + kb + ' KB') : 'Photo attached — you can correct the fields below.';
  }
}

export async function handlePhoto(file) {
  clearPendingPhoto();
  session.photoCleared = false;
  let previewUrl = '';
  try { previewUrl = URL.createObjectURL(file); } catch (e) {}
  let thumbDataUrl = '', ocrDataUrl = '';
  try { thumbDataUrl = await compressImage(file, 400, 0.6); } catch (e) {}
  try { ocrDataUrl = await compressImage(file, 1600, 0.7); } catch (e) {}
  session.pending = {
    originalFile: file,
    previewUrl,
    thumbDataUrl: thumbDataUrl || previewUrl,
    ocrDataUrl: ocrDataUrl || thumbDataUrl || previewUrl,
    ext: extFromFile(file)
  };
  showPreview();
}

export function applyOcrFields(data, overwrite) {
  if (!data) return;
  const cat = normalizeCategory(data.category);
  const set = (id, v) => {
    const el = $(id);
    if (!el || v == null || v === '') return;
    if (overwrite || !String(el.value || '').trim()) el.value = v;
  };
  set('m-seller', data.seller);
  if (data.date && $('m-date')) $('m-date').value = data.date;
  if (data.total != null && $('m-price')) $('m-price').value = data.total;
  set('m-item', data.item);
  set('m-category', cat);
  set('m-receipt', data.receipt);
}

async function saveInlineAiKey() {
  const k = $('m-ai-key'), p = $('m-ai-provider'), b = $('m-ai-base');
  if (p) settings.provider = p.value;
  if (k && k.value.trim()) settings.apiKey = k.value.trim();
  if (b) settings.apiBase = b.value.trim();
  const model = readModelValue('m-ai');
  if (model || settings.provider === 'custom') settings.model = model;
  const modelSel = $('m-ai-model');
  if (modelSel && Array.isArray(modelSel._allModels) && modelSel._allModels.length) settings.models = modelSel._allModels.slice(0, 400);
  if (!settings.apiKey) return false;
  if (settings.provider === 'custom' && (!settings.apiBase || !settings.model)) return false;
  await persistAiToProfile();
  return true;
}

export async function runOCR(overwrite) {
  const p = session.pending;
  if (!p || !(p.ocrDataUrl || p.previewUrl)) { ocrStatus('Take or upload a receipt photo first.', true); return; }
  const btn = $('m-ocr');
  if (btn) btn.disabled = true;
  ocrStatus('Reading receipt with ' + (settings.provider === 'custom' ? (settings.model || 'custom model') : settings.provider) + '…', false);
  try {
    const data = await callVisionOCR(p.ocrDataUrl || p.thumbDataUrl);
    applyOcrFields(data, !!overwrite);
    const cat = ($('m-category') && $('m-category').value) || 'Uncategorized';
    ocrStatus('AI filled ' + cat + '. Correct anything that’s wrong, then tap Save. The original photo stays attached.', false);
  } catch (err) {
    console.error(err);
    ocrStatus('Couldn\'t read receipt: ' + (err.message || 'error') + '. Keep the photo and enter details yourself.', true);
  }
  if (btn) btn.disabled = false;
}

export async function maybeScanAfterPhoto() {
  if (!session.pending) return;
  if (!settings.apiKey || (settings.provider === 'custom' && (!settings.apiBase || !settings.model))) {
    const ok = await saveInlineAiKey();
    if (!ok) { ocrStatus('Original photo is attached. Add an AI key to scan, or fill the fields and Save.', true); return; }
  }
  await runOCR(false);
}

export async function startReceiptScan() {
  if (!settings.apiKey || (settings.provider === 'custom' && (!settings.apiBase || !settings.model))) {
    const ok = await saveInlineAiKey();
    if (!ok) {
      const custom = settings.provider === 'custom';
      ocrStatus(custom ? ($('m-ai-base') ? 'Enter the API URL, model name, and key.' : 'Open Settings and enter the custom API URL and model.') : 'Paste your AI API key above, or in Settings.', true);
      const focus = $('m-ai-base') || $('m-ai-key');
      if (focus) focus.focus();
      return;
    }
  }
  if (session.pending) { await runOCR(true); return; }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.capture = 'environment';
  inp.onchange = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    await handlePhoto(f);
    await runOCR(false);
  };
  inp.click();
}

export function removePendingPhoto() {
  clearPendingPhoto();
  session.photoCleared = true;
  const pv = $('m-photo-preview');
  if (pv) pv.classList.remove('show');
  ['m-photo', 'm-photo-cam'].forEach(id => { const el = $(id); if (el) el.value = ''; });
}

export function openPhotoLightbox() {
  const p = session.pending;
  const src = (p && (p.previewUrl || p.thumbDataUrl)) || '';
  if (!src) return;
  $('lightbox-img').src = src;
  $('lightbox').classList.add('show');
}
