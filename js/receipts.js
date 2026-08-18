import {settings, session} from './store.js?v=20260818h';
import {$, toast, compressImage, extFromFile, normalizeCategory, parseMoney, parseDateISO, esc} from './util.js?v=20260818h';
import {callVisionOCR, persistAiToProfile, readModelValue} from './ai.js?v=20260818h';

export function ocrStatus(msg, err) {
  const el = $('m-ocr-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  el.classList.toggle('err', !!err);
}

export function clearPendingPhoto() {
  const p = session.pending;
  if (p && Array.isArray(p.photos)) {
    p.photos.forEach(ph => { if (ph && ph.previewUrl) try { URL.revokeObjectURL(ph.previewUrl); } catch (e) {} });
  } else if (p && p.previewUrl) {
    try { URL.revokeObjectURL(p.previewUrl); } catch (e) {}
  }
  session.pending = null;
}

function showPreview() {
  const p = session.pending;
  const list = $('m-photo-list'), pv = $('m-photo-preview'), meta = $('m-photo-meta');
  if (!list || !pv || !p || !Array.isArray(p.photos) || !p.photos.length) return;
  list.innerHTML = p.photos.map((ph, i) =>
    '<img src="' + esc(ph.thumbDataUrl || ph.previewUrl || '') + '" data-photo-idx="' + i + '" alt="Receipt page ' + (i + 1) + '">'
  ).join('');
  list.querySelectorAll('[data-photo-idx]').forEach(im => {
    im.onclick = () => openPhotoLightbox(Number(im.dataset.photoIdx || 0));
  });
  pv.classList.add('show');
  if (meta) {
    const files = p.photos.filter(ph => ph && ph.originalFile);
    const kb = files.reduce((s, ph) => s + Math.max(1, Math.round((ph.originalFile.size || 0) / 1024)), 0);
    meta.textContent = files.length
      ? (files.length + ' photo' + (files.length === 1 ? '' : 's') + ' attached · ' + kb + ' KB total')
      : 'Photo attached — correct the table below.';
  }
}

function firstPendingPhoto() {
  const p = session.pending;
  return (p && Array.isArray(p.photos) && p.photos[0]) || null;
}

export async function handlePhoto(file, append) {
  if (!append) clearPendingPhoto();
  session.photoCleared = false;
  let previewUrl = '';
  try { previewUrl = URL.createObjectURL(file); } catch (e) {}
  let thumbDataUrl = '', ocrDataUrl = '';
  try { thumbDataUrl = await compressImage(file, 400, 0.6); } catch (e) {}
  try { ocrDataUrl = await compressImage(file, 2000, 0.85); } catch (e) {}
  const nextPhoto = {
    originalFile: file,
    previewUrl,
    thumbDataUrl: thumbDataUrl || previewUrl,
    ocrDataUrl: ocrDataUrl || thumbDataUrl || previewUrl,
    ext: extFromFile(file)
  };
  if (!session.pending || !Array.isArray(session.pending.photos)) session.pending = {photos: []};
  session.pending.photos.push(nextPhoto);
  showPreview();
}

function emptyLine() { return {item: '', qty: '', rate: '', amount: ''}; }

function normalizeLine(ln) {
  if (ln == null) return emptyLine();
  if (typeof ln === 'string') return {item: ln, qty: '', rate: '', amount: ''};
  const amount = parseMoney(ln.amount ?? ln.total ?? ln.line_total ?? ln.lineTotal);
  const rate = parseMoney(ln.rate ?? ln.unit_price ?? ln.unitPrice ?? ln.price);
  return {
    item: String(ln.item || ln.description || ln.name || ln.product || '').trim(),
    qty: ln.qty != null && ln.qty !== '' ? ln.qty : (ln.quantity != null ? ln.quantity : ''),
    rate: rate === '' ? '' : rate,
    amount: amount === '' ? '' : amount
  };
}

export function normalizeOcr(data) {
  if (!data) return null;
  if (Array.isArray(data)) data = {lines: data};
  if (typeof data !== 'object') return null;
  let lines = data.lines || data.items || data.products || data.details || [];
  if (!Array.isArray(lines)) lines = [];
  lines = lines.map(normalizeLine).filter(l => l.item || l.amount !== '');
  const total = parseMoney(data.total ?? data.grand_total ?? data.grandTotal ?? data.amount ?? data.net_amount);
  const seller = String(data.seller || data.vendor || data.store || data.merchant || data.shop || data.company || '').trim();
  const receipt = String(data.receipt || data.invoice || data.invoice_no || data.invoice_number || data.bill_no || data.receipt_no || '').trim();
  const date = parseDateISO(data.date || data.invoice_date || data.bill_date || data.dated);
  const item = String(data.item || data.summary || '').trim() || lines.map(l => l.item).filter(Boolean).slice(0, 4).join(', ');
  const category = normalizeCategory(data.category);
  if (!lines.length && (item || total !== '')) lines = [{item: item || '', qty: '', rate: '', amount: total}];
  return {seller, date, receipt, category, total, item, lines};
}

function lineRowHtml(ln) {
  ln = ln || emptyLine();
  return '<tr>' +
    '<td class="col-item"><input class="ln-item" value="' + esc(ln.item) + '" placeholder="Item" autocomplete="off"></td>' +
    '<td class="col-qty"><input class="ln-qty" value="' + esc(ln.qty) + '" placeholder="Qty" inputmode="decimal"></td>' +
    '<td class="col-rate"><input class="ln-rate" value="' + esc(ln.rate) + '" placeholder="Rate" inputmode="decimal"></td>' +
    '<td class="col-amt"><input class="ln-amount" value="' + esc(ln.amount) + '" placeholder="Rs" inputmode="decimal"></td>' +
    '<td class="col-del"><button type="button" class="ln-del" aria-label="Remove row">&times;</button></td>' +
    '</tr>';
}

export function purchaseLinesHtml(lines) {
  const rows = (lines && lines.length) ? lines : [emptyLine()];
  return '<div class="receipt-table-wrap">' +
    '<table class="receipt-table"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th><th></th></tr></thead>' +
    '<tbody id="m-lines">' + rows.map(lineRowHtml).join('') + '</tbody></table></div>' +
    '<button type="button" class="line-add" id="m-line-add">+ Add row</button>';
}

export function readLinesFromTable() {
  const body = $('m-lines');
  if (!body) return [];
  return [...body.querySelectorAll('tr')].map(tr => ({
    item: (tr.querySelector('.ln-item') && tr.querySelector('.ln-item').value.trim()) || '',
    qty: (tr.querySelector('.ln-qty') && tr.querySelector('.ln-qty').value.trim()) || '',
    rate: parseMoney(tr.querySelector('.ln-rate') && tr.querySelector('.ln-rate').value),
    amount: parseMoney(tr.querySelector('.ln-amount') && tr.querySelector('.ln-amount').value)
  })).filter(l => l.item || l.amount !== '');
}

function sumLines(lines) {
  return lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
}

function syncTotalFromLines() {
  const totalEl = $('m-price');
  if (!totalEl) return;
  const sum = sumLines(readLinesFromTable());
  if (sum) totalEl.value = String(Math.round(sum * 100) / 100);
}

function fillSummaryFromLines() {
  const itemEl = $('m-item');
  if (!itemEl) return;
  const names = readLinesFromTable().map(l => l.item).filter(Boolean);
  if (!String(itemEl.value || '').trim() && names.length) itemEl.value = names.slice(0, 4).join(', ');
}

export function renderLinesIntoTable(lines, overwrite) {
  const body = $('m-lines');
  if (!body) return;
  const next = (lines && lines.length) ? lines : [emptyLine()];
  if (overwrite || !readLinesFromTable().length) body.innerHTML = next.map(lineRowHtml).join('');
  bindLineTable();
}

export function bindLineTable() {
  const body = $('m-lines');
  const add = $('m-line-add');
  if (add && !add._lineBound) {
    add._lineBound = true;
    add.onclick = () => {
      const tb = $('m-lines');
      if (!tb) return;
      tb.insertAdjacentHTML('beforeend', lineRowHtml(emptyLine()));
    };
  }
  if (!body || body._lineBound) return;
  body._lineBound = true;
  body.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.ln-del');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (tr && body.querySelectorAll('tr').length > 1) tr.remove();
    else if (tr) tr.querySelectorAll('input').forEach(i => { i.value = ''; });
    syncTotalFromLines();
    fillSummaryFromLines();
  });
  body.addEventListener('input', e => {
    const tr = e.target && e.target.closest && e.target.closest('tr');
    if (!tr) return;
    if (e.target.classList.contains('ln-qty') || e.target.classList.contains('ln-rate')) {
      const qty = parseMoney(tr.querySelector('.ln-qty').value);
      const rate = parseMoney(tr.querySelector('.ln-rate').value);
      const amt = tr.querySelector('.ln-amount');
      if (qty !== '' && rate !== '' && amt) amt.value = String(Math.round(Number(qty) * Number(rate) * 100) / 100);
    }
    syncTotalFromLines();
    fillSummaryFromLines();
  });
}

export function applyOcrFields(raw, overwrite) {
  const data = normalizeOcr(raw);
  if (!data) return null;
  const set = (id, v) => {
    const el = $(id);
    if (!el || v == null || v === '') return false;
    if (overwrite || !String(el.value || '').trim()) { el.value = v; return true; }
    return false;
  };
  const filled = [];
  if (set('m-seller', data.seller)) filled.push('seller');
  if (data.date) {
    const dEl = $('m-date');
    if (dEl && (overwrite || !String(dEl.value || '').trim())) { dEl.value = data.date; filled.push('date'); }
  }
  if (set('m-category', data.category)) filled.push('category');
  if (set('m-receipt', data.receipt)) filled.push('receipt no.');
  renderLinesIntoTable(data.lines, overwrite);
  const sum = sumLines(data.lines);
  const total = data.total !== '' && data.total != null ? data.total : sum;
  if (total !== '' && $('m-price') && (overwrite || !String($('m-price').value || '').trim())) {
    $('m-price').value = total;
    filled.push('total');
  }
  if (set('m-item', data.item)) filled.push('summary');
  if (data.lines.length) filled.push(data.lines.length + ' line' + (data.lines.length === 1 ? '' : 's'));
  return {data, filled};
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
  const photos = p && Array.isArray(p.photos) ? p.photos : [];
  if (!photos.length) { ocrStatus('Take or upload a receipt photo first.', true); return; }
  const btn = $('m-ocr');
  if (btn) btn.disabled = true;
  ocrStatus('Reading ' + photos.length + ' receipt page' + (photos.length === 1 ? '' : 's') + ' with ' + (settings.provider === 'custom' ? (settings.model || 'custom model') : settings.provider) + '…', false);
  try {
    const merged = {seller: '', date: '', receipt: '', category: '', total: '', item: '', lines: []};
    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      ocrStatus('Reading page ' + (i + 1) + ' of ' + photos.length + '…', false);
      const raw = await callVisionOCR(ph.ocrDataUrl || ph.thumbDataUrl || ph.previewUrl);
      const d = normalizeOcr(raw);
      if (!d) continue;
      if (!merged.seller && d.seller) merged.seller = d.seller;
      if (!merged.date && d.date) merged.date = d.date;
      if (!merged.receipt && d.receipt) merged.receipt = d.receipt;
      if (!merged.category && d.category) merged.category = d.category;
      if (!merged.item && d.item) merged.item = d.item;
      if (Array.isArray(d.lines) && d.lines.length) merged.lines.push(...d.lines);
    }
    const result = applyOcrFields(merged, !!overwrite);
    const n = result && result.data && result.data.lines ? result.data.lines.length : 0;
    const who = ($('m-seller') && $('m-seller').value) || 'the receipt';
    if (!n && !($('m-seller') && $('m-seller').value) && !($('m-price') && $('m-price').value)) {
      ocrStatus('AI could not read line items from these photos. Type them into the table, or tap Re-scan.', true);
    } else {
      ocrStatus('Filled the table from ' + who + ' · ' + photos.length + ' page' + (photos.length === 1 ? '' : 's') + (n ? (' · ' + n + ' line' + (n === 1 ? '' : 's')) : '') + '. Correct anything that’s wrong, then Save.', false);
    }
  } catch (err) {
    console.error(err);
    ocrStatus('Couldn\'t read receipt: ' + (err.message || 'error') + '. Keep the photo and fill the table yourself.', true);
  }
  if (btn) btn.disabled = false;
}

export async function maybeScanAfterPhoto() {
  if (!session.pending) return;
  if (!settings.apiKey || (settings.provider === 'custom' && (!settings.apiBase || !settings.model))) {
    const ok = await saveInlineAiKey();
    if (!ok) { ocrStatus('Original photo is attached. Add an AI key to scan, or fill the table and Save.', true); return; }
  }
  await runOCR(true);
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
  inp.multiple = true;
  inp.onchange = async e => {
    const fs = [...(e.target.files || [])];
    if (!fs.length) return;
    clearPendingPhoto();
    for (const f of fs) await handlePhoto(f, true);
    await runOCR(true);
  };
  inp.click();
}

export function removePendingPhoto() {
  clearPendingPhoto();
  session.photoCleared = true;
  const pv = $('m-photo-preview');
  if (pv) pv.classList.remove('show');
  const list = $('m-photo-list');
  if (list) list.innerHTML = '';
  ['m-photo', 'm-photo-cam'].forEach(id => { const el = $(id); if (el) el.value = ''; });
}

export function openPhotoLightbox(idx) {
  const p = session.pending;
  const ph = (p && Array.isArray(p.photos) && p.photos[idx || 0]) || firstPendingPhoto();
  const src = (ph && (ph.previewUrl || ph.thumbDataUrl)) || '';
  if (!src) return;
  $('lightbox-img').src = src;
  $('lightbox').classList.add('show');
}

export function readPurchaseForm() {
  const lines = readLinesFromTable();
  const seller = ($('m-seller') && $('m-seller').value.trim()) || '';
  const date = ($('m-date') && $('m-date').value) || '';
  const receipt = ($('m-receipt') && $('m-receipt').value.trim()) || '';
  const category = normalizeCategory(($('m-category') && $('m-category').value.trim()) || '');
  // Always prefer the sum of line amounts as the authoritative total.
  // Fall back to the manual total field only if there are no lines.
  const lineSum = sumLines(lines);
  let price = lineSum || parseMoney($('m-price') && $('m-price').value);
  const item = (($('m-item') && $('m-item').value.trim()) || lines.map(l => l.item).filter(Boolean).join(', ')).trim();
  return {lines, seller, date, receipt, category, price, item};
}
