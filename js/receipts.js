import {settings, session} from './store.js?v=20260818s';
import {$, toast, compressImage, extFromFile, normalizeCategory, parseMoney, parseDateISO, esc, lineAmount, sumLines, summarizePurchase, guessCategoryFromItem, itemsLookSame} from './util.js?v=20260818s';
import {CATEGORIES} from './config.js?v=20260818s';
import {callVisionOCR, callJsonCompletion, persistAiToProfile, readModelValue} from './ai.js?v=20260818s';

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

function emptyLine() { return {item: '', qty: '', rate: '', amount: '', category: ''}; }

function catSelectHtml(selected) {
  const sel = normalizeCategory(selected);
  return '<select class="ln-cat" aria-label="Category"><option value="">Category</option>' +
    CATEGORIES.map(c => '<option value="' + esc(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
    '</select>';
}

export function categoryPillsHtml(selected) {
  const set = new Set((selected || []).map(normalizeCategory).filter(Boolean));
  return '<div class="cat-pills" id="m-cat-pills">' +
    CATEGORIES.map(c => '<button type="button" class="cat-pill' + (set.has(c) ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('') +
    '</div>';
}

export function readSelectedCategories() {
  const fromLines = readLinesFromTable().map(l => normalizeCategory(l.category)).filter(Boolean);
  const fromPills = selectedPillCategories();
  return [...new Set(fromPills.concat(fromLines))];
}

export function selectedPillCategories() {
  return [...document.querySelectorAll('#m-cat-pills .cat-pill.on')].map(b => normalizeCategory(b.dataset.cat)).filter(Boolean);
}

export function syncPillsFromLines() {
  const cats = new Set(readLinesFromTable().map(l => normalizeCategory(l.category)).filter(Boolean));
  document.querySelectorAll('#m-cat-pills .cat-pill').forEach(b => {
    if (cats.size) b.classList.toggle('on', cats.has(b.dataset.cat));
  });
}

function turnOnPillsFromLines() {
  const cats = new Set(readLinesFromTable().map(l => normalizeCategory(l.category)).filter(Boolean));
  document.querySelectorAll('#m-cat-pills .cat-pill').forEach(b => {
    if (cats.has(b.dataset.cat)) b.classList.add('on');
  });
}

function fillStatus(msg, err) {
  const el = $('m-fill-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}

/** Fill empty line-category dropdowns. One selected pill copies to all blanks; several pills use item-name heuristics. Never overwrites a set category. */
export function prefillEmptyLineCategories() {
  const pills = selectedPillCategories();
  const body = $('m-lines');
  if (!body) return 0;
  const rows = [...body.querySelectorAll('tr')];
  const siblingItems = rows.map(tr => (tr.querySelector('.ln-item') && tr.querySelector('.ln-item').value) || '');
  let n = 0;
  rows.forEach(tr => {
    const sel = tr.querySelector('.ln-cat');
    if (!sel || String(sel.value || '').trim()) return;
    const item = (tr.querySelector('.ln-item') && tr.querySelector('.ln-item').value) || '';
    let cat = '';
    if (pills.length === 1) cat = pills[0];
    else cat = guessCategoryFromItem(item, {allowed: pills, siblingItems});
    if (cat) {
      sel.value = cat;
      n++;
    }
  });
  if (n) turnOnPillsFromLines();
  return n;
}

function normalizeLine(ln) {
  if (ln == null) return emptyLine();
  if (typeof ln === 'string') return {item: ln, qty: '', rate: '', amount: '', category: ''};
  const amount = parseMoney(ln.amount ?? ln.total ?? ln.line_total ?? ln.lineTotal);
  const rate = parseMoney(ln.rate ?? ln.unit_price ?? ln.unitPrice ?? ln.price);
  const qty = ln.qty != null && ln.qty !== '' ? ln.qty : (ln.quantity != null ? ln.quantity : '');
  const line = {
    item: String(ln.item || ln.description || ln.name || ln.product || '').trim(),
    qty,
    rate: rate === '' ? '' : rate,
    amount: amount === '' ? '' : amount,
    category: normalizeCategory(ln.category || ln.cat || '')
  };
  const computed = lineAmount(line);
  if (computed) line.amount = computed;
  return line;
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
  const fromLines = [...new Set(lines.map(l => l.category).filter(Boolean))];
  let categories = [];
  if (Array.isArray(data.categories)) categories = data.categories.map(normalizeCategory).filter(Boolean);
  const oneCat = normalizeCategory(data.category);
  if (oneCat) categories.push(oneCat);
  categories = [...new Set(categories.concat(fromLines))];
  if (!lines.length && (data.item || data.summary || total !== '')) {
    lines = [{item: String(data.item || data.summary || '').trim(), qty: '', rate: '', amount: total, category: oneCat || ''}];
  }
  const siblingItems = lines.map(l => l.item);
  lines.forEach(l => {
    if (l.category) return;
    l.category = guessCategoryFromItem(l.item, {allowed: categories, siblingItems});
    if (!l.category && categories.length === 1) l.category = categories[0];
  });
  categories = [...new Set(categories.concat(lines.map(l => l.category).filter(Boolean)))];
  const item = String(data.summary || data.item || '').trim() || summarizePurchase(seller, lines);
  return {seller, date, receipt, category: categories[0] || '', categories, total, item, lines};
}

function lineRowHtml(ln) {
  ln = ln || emptyLine();
  return '<tr>' +
    '<td class="col-item"><input class="ln-item" value="' + esc(ln.item) + '" placeholder="Item" autocomplete="off"></td>' +
    '<td class="col-qty"><input class="ln-qty" value="' + esc(ln.qty) + '" placeholder="Qty" inputmode="decimal"></td>' +
    '<td class="col-rate"><input class="ln-rate" value="' + esc(ln.rate) + '" placeholder="Rate" inputmode="decimal"></td>' +
    '<td class="col-amt"><input class="ln-amount" value="' + esc(ln.amount) + '" placeholder="Rs" inputmode="decimal"></td>' +
    '<td class="col-cat">' + catSelectHtml(ln.category) + '</td>' +
    '<td class="col-del"><button type="button" class="ln-del" aria-label="Remove row">&times;</button></td>' +
    '</tr>';
}

export function purchaseLinesHtml(lines) {
  const rows = (lines && lines.length) ? lines : [emptyLine()];
  return '<div class="receipt-table-wrap">' +
    '<table class="receipt-table"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Category</th><th></th></tr></thead>' +
    '<tbody id="m-lines">' + rows.map(lineRowHtml).join('') + '</tbody></table></div>' +
    '<button type="button" class="line-add" id="m-line-add">+ Add row</button>';
}

export function readLinesFromTable() {
  const body = $('m-lines');
  if (!body) return [];
  return [...body.querySelectorAll('tr')].map(tr => {
    const row = {
      item: (tr.querySelector('.ln-item') && tr.querySelector('.ln-item').value.trim()) || '',
      qty: (tr.querySelector('.ln-qty') && tr.querySelector('.ln-qty').value.trim()) || '',
      rate: parseMoney(tr.querySelector('.ln-rate') && tr.querySelector('.ln-rate').value),
      amount: parseMoney(tr.querySelector('.ln-amount') && tr.querySelector('.ln-amount').value),
      category: normalizeCategory(tr.querySelector('.ln-cat') && tr.querySelector('.ln-cat').value)
    };
    const computed = lineAmount(row);
    if (computed) row.amount = computed;
    return row;
  }).filter(l => l.item || l.amount !== '');
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
  const lines = readLinesFromTable();
  const next = summarizePurchase(($('m-seller') && $('m-seller').value.trim()) || '', lines);
  if (!String(itemEl.value || '').trim() || itemEl.dataset.autogen === '1') {
    itemEl.value = next;
    itemEl.dataset.autogen = '1';
  }
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
  body.addEventListener('change', e => {
    if (e.target && e.target.classList.contains('ln-cat')) {
      syncPillsFromLines();
      fillSummaryFromLines();
    }
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
  const cats = data.categories && data.categories.length ? data.categories : (data.category ? [data.category] : []);
  if (cats.length) {
    document.querySelectorAll('#m-cat-pills .cat-pill').forEach(b => {
      if (cats.includes(b.dataset.cat)) b.classList.add('on');
    });
  }
  prefillEmptyLineCategories();
  const stillEmpty = readLinesFromTable().some(l => l.item && !l.category);
  if (overwrite && !stillEmpty) syncPillsFromLines();
  else turnOnPillsFromLines();
  const sum = sumLines(data.lines);
  const total = data.total !== '' && data.total != null ? data.total : sum;
  if (total !== '' && $('m-price') && (overwrite || !String($('m-price').value || '').trim())) {
    $('m-price').value = total;
    filled.push('total');
  }
  const summary = data.item || summarizePurchase(data.seller, data.lines);
  const itemEl = $('m-item');
  if (itemEl && summary && (overwrite || !String(itemEl.value || '').trim() || itemEl.dataset.autogen === '1')) {
    itemEl.value = summary;
    itemEl.dataset.autogen = '1';
    filled.push('summary');
  }
  if (data.lines.length) filled.push(data.lines.length + ' line' + (data.lines.length === 1 ? '' : 's'));
  return {data, filled};
}

function hasAiReady() {
  if (!settings.apiKey) return false;
  if (settings.provider === 'custom' && (!settings.apiBase || !settings.model)) return false;
  return true;
}

function pendingPhotoUrls() {
  const p = session.pending;
  const photos = p && Array.isArray(p.photos) ? p.photos : [];
  return photos.map(ph => ph && (ph.ocrDataUrl || ph.thumbDataUrl || ph.previewUrl)).filter(Boolean);
}

function missingFillPrompt(lines) {
  const pills = selectedPillCategories();
  const rows = (lines || []).map((l, i) =>
    (i + 1) + '. item=' + JSON.stringify(l.item || '') +
    ' qty=' + JSON.stringify(l.qty === '' || l.qty == null ? '' : l.qty) +
    ' rate=' + JSON.stringify(l.rate === '' || l.rate == null ? '' : l.rate) +
    ' amount=' + JSON.stringify(l.amount === '' || l.amount == null ? '' : l.amount) +
    ' category=' + JSON.stringify(l.category || '')
  ).join('\n');
  return 'You fill missing fields on construction receipt line items. Reply ONLY with JSON: {"lines":[{"item":string,"qty":number|string,"rate":number,"amount":number,"category":string}]}. '
    + 'category must be exactly one of: ' + CATEGORIES.join(', ') + '. '
    + (pills.length ? ('Prefer these selected bill categories when guessing: ' + pills.join(', ') + '. ') : '')
    + 'Never change a non-empty category. ISO-RANGE / ISORANGE / rouleau / insulation tape / cole HTA = Electrical. PVC / elbow / tuyaux / pyn / rifen / bend / cpvc = Plumbing. Glue / LA COLE near pipes = Plumbing, otherwise Electrical. '
    + 'Return one object per current line, in the same order. Keep existing non-empty fields. '
    + 'Current lines:\n' + (rows || '(none)');
}

function setBlankField(el, v) {
  if (!el || v == null || v === '') return false;
  if (String(el.value || '').trim()) return false;
  el.value = String(v);
  return true;
}

function applyMissingFromAiLines(aiLines) {
  const body = $('m-lines');
  if (!body || !Array.isArray(aiLines) || !aiLines.length) return 0;
  const rows = [...body.querySelectorAll('tr')];
  const used = new Set();
  let n = 0;
  rows.forEach((tr, i) => {
    const itemVal = (tr.querySelector('.ln-item') && tr.querySelector('.ln-item').value.trim()) || '';
    let idx = -1;
    if (aiLines[i] && !used.has(i) && (!itemVal || itemsLookSame(itemVal, aiLines[i].item))) idx = i;
    if (idx < 0 && itemVal) {
      idx = aiLines.findIndex((l, j) => !used.has(j) && itemsLookSame(itemVal, l && l.item));
    }
    if (idx < 0) return;
    used.add(idx);
    const ai = normalizeLine(aiLines[idx]);
    const catEl = tr.querySelector('.ln-cat');
    if (catEl && !String(catEl.value || '').trim() && ai.category) {
      catEl.value = ai.category;
      n++;
    }
    if (setBlankField(tr.querySelector('.ln-item'), ai.item)) n++;
    if (setBlankField(tr.querySelector('.ln-qty'), ai.qty === '' ? '' : ai.qty)) n++;
    if (setBlankField(tr.querySelector('.ln-rate'), ai.rate === '' ? '' : ai.rate)) n++;
    if (setBlankField(tr.querySelector('.ln-amount'), ai.amount === '' ? '' : ai.amount)) n++;
  });
  return n;
}

export async function fillMissingWithAi() {
  const btn = $('m-fill-ai');
  const lines = readLinesFromTable();
  const needCat = lines.some(l => l.item && !l.category);
  const needOther = lines.some(l => l.item && (l.qty === '' || l.rate === ''));
  if (!needCat && !needOther) {
    fillStatus('Every line already has a category.');
    toast('Every line already has a category.');
    return;
  }
  const prevLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Filling…';
  }
  let filled = 0;
  let used = 'local';
  try {
    const photos = pendingPhotoUrls();
    if (hasAiReady()) {
      fillStatus(photos.length
        ? 'Asking AI to fill missing fields from the receipt photo…'
        : 'Asking AI to fill missing categories from the line items…');
      try {
        const raw = await callJsonCompletion(missingFillPrompt(lines), photos);
        const d = normalizeOcr(raw);
        const nAi = applyMissingFromAiLines(d && d.lines);
        filled += nAi;
        if (nAi) used = 'ai';
      } catch (e) {
        used = 'local';
        fillStatus('AI fill failed (' + (e.message || 'error') + '). Using item-name guess…', true);
      }
    } else {
      fillStatus('No AI key — filling empty categories from item names…');
    }
    filled += prefillEmptyLineCategories();
    if (filled) {
      syncTotalFromLines();
      fillSummaryFromLines();
      turnOnPillsFromLines();
    }
    const msg = filled
      ? ('Filled ' + filled + ' missing field' + (filled === 1 ? '' : 's') + (used === 'ai' ? ' with AI' : ' from item names') + '.')
      : 'Could not guess remaining categories. Pick them in the table.';
    fillStatus(msg, !filled);
    toast(msg);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel || 'Fill missing with AI';
    }
  }
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
    const merged = {seller: '', date: '', receipt: '', category: '', categories: [], total: '', item: '', lines: []};
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
      if (Array.isArray(d.categories)) merged.categories.push(...d.categories);
      if (!merged.item && d.item) merged.item = d.item;
      if (Array.isArray(d.lines) && d.lines.length) merged.lines.push(...d.lines);
    }
    merged.categories = [...new Set(merged.categories.concat(merged.lines.map(l => l.category)).filter(Boolean))];
    if (!merged.item) merged.item = summarizePurchase(merged.seller, merged.lines);
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
  const img = $('lightbox-img'), box = $('lightbox');
  if (img) img.src = src;
  if (box) box.classList.add('show');
}

export function readPurchaseForm() {
  const lines = readLinesFromTable();
  const seller = ($('m-seller') && $('m-seller').value.trim()) || '';
  const date = ($('m-date') && $('m-date').value) || '';
  const receipt = ($('m-receipt') && $('m-receipt').value.trim()) || '';
  const categories = readSelectedCategories();
  const category = categories[0] || '';
  const lineSum = sumLines(lines);
  let price = lineSum || parseMoney($('m-price') && $('m-price').value);
  const item = (($('m-item') && $('m-item').value.trim()) || summarizePurchase(seller, lines)).trim();
  return {lines, seller, date, receipt, category, categories, price, item};
}
