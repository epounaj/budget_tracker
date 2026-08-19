import {settings, session} from './store.js?v=20260819f';
import {$, toast, normalizeCategory, parseMoney, parseDateISO, esc, lineAmount, sumLines, summarizePurchase, guessCategoryFromItem, itemsLookSame, isBankName, allTradeCategories} from './util.js?v=20260819f';
import {CATEGORIES} from './config.js?v=20260819f';
import {callVisionOCR, callJsonCompletion, persistAiToProfile, readModelValue} from './ai.js?v=20260819f';
import {pendingPhotos, ocrSrc, handlePhoto, clearPendingPhoto} from './photos.js?v=20260819f';
import {hub} from './hub.js?v=20260819f';

export {handlePhoto, clearPendingPhoto, removePendingPhoto} from './photos.js?v=20260819f';

export function ocrStatus(msg, err) {
  const el = $('m-ocr-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  el.classList.toggle('err', !!err);
}

function photoNoun() {
  if (session.editKind === 'sellers') return 'quote';
  if (session.editKind === 'labour') return 'payment proof';
  return 'receipt';
}

function emptyLine() { return {item: '', qty: '', rate: '', amount: '', category: '', seller: '', contact: ''}; }

function tableHasCat() {
  const body = $('m-lines');
  return !(body && body.getAttribute('data-skip-cat') === '1');
}

function tableHasSeller() {
  const body = $('m-lines');
  return !!(body && body.getAttribute('data-with-seller') === '1');
}

export function sellerNameKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeContact(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x) return y;
  if (!y || x === y || x.toLowerCase().includes(y.toLowerCase())) return x;
  if (y.toLowerCase().includes(x.toLowerCase())) return y;
  return x + ' · ' + y;
}

function catSelectHtml(selected) {
  const sel = normalizeCategory(selected);
  return '<select class="ln-cat" aria-label="Category"><option value="">Category</option>' +
    CATEGORIES.map(c => '<option value="' + esc(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
    allTradeCategories().filter(c => !CATEGORIES.includes(c)).map(c => '<option value="' + esc(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
    '</select>';
}

export function categoryPillsHtml(selected) {
  const set = new Set((selected || []).map(normalizeCategory).filter(Boolean));
  return '<div class="cat-pills" id="m-cat-pills">' +
    allTradeCategories().map(c => '<button type="button" class="cat-pill' + (set.has(c) ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('') +
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
  const photoIndex = ln.photoIndex != null && ln.photoIndex !== '' ? Number(ln.photoIndex) : '';
  const line = {
    item: String(ln.item || ln.description || ln.name || ln.product || '').trim(),
    qty,
    rate: rate === '' ? '' : rate,
    amount: amount === '' ? '' : amount,
    category: normalizeCategory(ln.category || ln.cat || ''),
    seller: String(ln.seller || ln.vendor || ln.store || ln.shop || '').trim(),
    contact: String(ln.contact || ln.phone || ln.tel || ln.mobile || ln.whatsapp || ln.email || '').trim(),
    photoIndex: photoIndex === '' || Number.isNaN(photoIndex) ? '' : photoIndex
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
  lines = lines.map(normalizeLine).filter(l => l.item || l.amount !== '' || l.seller);
  const total = parseMoney(data.total ?? data.grand_total ?? data.grandTotal ?? data.amount ?? data.net_amount);
  const seller = String(data.seller || data.vendor || data.store || data.merchant || data.shop || data.company || '').trim();
  const contact = String(data.contact || data.phone || data.tel || data.mobile || data.whatsapp || data.email || '').trim();
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
  if (seller) lines.forEach(l => { if (!l.seller) l.seller = seller; });
  if (contact) lines.forEach(l => { if (!l.contact) l.contact = contact; });
  return {seller, contact, date, receipt, category: categories[0] || '', categories, total, item, lines};
}

function lineRowHtml(ln, withCat, withSeller) {
  ln = ln || emptyLine();
  if (withCat == null) withCat = tableHasCat();
  if (withSeller == null) withSeller = tableHasSeller();
  const photoAttr = (ln.photoIndex !== '' && ln.photoIndex != null) ? (' data-photo="' + esc(ln.photoIndex) + '"') : '';
  return '<tr' + photoAttr + '>' +
    (withSeller
      ? ('<td class="col-seller"><input class="ln-seller" value="' + esc(ln.seller) + '" placeholder="Seller" autocomplete="off"></td>' +
         '<td class="col-contact"><input class="ln-contact" value="' + esc(ln.contact) + '" placeholder="Contact" autocomplete="off"></td>')
      : '') +
    '<td class="col-item"><input class="ln-item" value="' + esc(ln.item) + '" placeholder="Item" autocomplete="off"></td>' +
    '<td class="col-qty"><input class="ln-qty" value="' + esc(ln.qty) + '" placeholder="Qty" inputmode="decimal"></td>' +
    '<td class="col-rate"><input class="ln-rate" value="' + esc(ln.rate) + '" placeholder="Rate" inputmode="decimal"></td>' +
    '<td class="col-amt"><input class="ln-amount" value="' + esc(ln.amount) + '" placeholder="Rs" inputmode="decimal"></td>' +
    (withCat ? '<td class="col-cat">' + catSelectHtml(ln.category) + '</td>' : '') +
    '<td class="col-del"><button type="button" class="ln-del" aria-label="Remove row">&times;</button></td>' +
    '</tr>';
}

export function purchaseLinesHtml(lines, opts) {
  const skip = !!(opts && opts.skipCategory);
  const withSeller = !!(opts && opts.withSeller);
  const rows = (lines && lines.length) ? lines : [emptyLine()];
  return '<div class="receipt-table-wrap">' +
    '<table class="receipt-table' + (withSeller ? ' with-seller' : '') + '"><thead><tr>' +
    (withSeller ? '<th>Seller</th><th>Contact</th>' : '') +
    '<th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th>' +
    (skip ? '' : '<th>Category</th>') + '<th></th></tr></thead>' +
    '<tbody id="m-lines"' + (skip ? ' data-skip-cat="1"' : '') + (withSeller ? ' data-with-seller="1"' : '') + '>' +
    rows.map(ln => lineRowHtml(ln, !skip, withSeller)).join('') + '</tbody></table></div>' +
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
    const sellerEl = tr.querySelector('.ln-seller');
    if (sellerEl) {
      row.seller = sellerEl.value.trim();
      row.contact = (tr.querySelector('.ln-contact') && tr.querySelector('.ln-contact').value.trim()) || '';
      if (tr.dataset.photo !== undefined && tr.dataset.photo !== '') row.photoIndex = tr.dataset.photo;
    }
    const computed = lineAmount(row);
    if (computed) row.amount = computed;
    return row;
  }).filter(l => l.item || l.amount !== '' || l.seller);
}

function syncTotalFromLines() {
  const totalEl = $('m-price');
  if (!totalEl) return;
  if (tableHasSeller()) {
    const fallback = ($('m-name') && $('m-name').value) || '';
    const names = new Set(readLinesFromTable().map(l => sellerNameKey(l.seller || fallback)).filter(Boolean));
    if (names.size > 1) return;
  }
  const sum = sumLines(readLinesFromTable());
  if (sum) totalEl.value = String(Math.round(sum * 100) / 100);
}

function fillSummaryFromLines() {
  if (tableHasSeller()) return;
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
  if (overwrite || !readLinesFromTable().length) body.innerHTML = next.map(ln => lineRowHtml(ln, tableHasCat())).join('');
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
      const ln = emptyLine();
      if (tableHasSeller()) {
        ln.seller = ($('m-name') && $('m-name').value.trim()) || '';
        ln.contact = ($('m-contact') && $('m-contact').value.trim()) || '';
      }
      tb.insertAdjacentHTML('beforeend', lineRowHtml(ln, tableHasCat()));
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

function applyLabourOcrFields(data, overwrite) {
  const set = (id, v) => {
    const el = $(id);
    if (!el || v == null || v === '') return false;
    if (overwrite || !String(el.value || '').trim()) { el.value = v; return true; }
    return false;
  };
  const filled = [];
  const payee = inferPayeeFromOcr(data);
  if (set('m-payee', payee)) filled.push('paid to');
  let cat = data.category || (data.categories && data.categories[0]) || '';
  if (!cat && data.item) cat = guessCategoryFromItem(data.item, {allowed: allTradeCategories()});
  if (!cat && data.lines && data.lines[0]) {
    cat = data.lines[0].category || guessCategoryFromItem(data.lines[0].item, {allowed: allTradeCategories()});
  }
  if (set('m-category', cat)) filled.push('trade');
  if (data.date) {
    const dEl = $('m-date');
    if (dEl && (overwrite || !String(dEl.value || '').trim())) { dEl.value = data.date; filled.push('date'); }
  }
  if (isBankName(data.seller)) {
    const mEl = $('m-method');
    if (mEl && (overwrite || !String(mEl.value || '').trim())) {
      mEl.value = /juice/i.test(String(data.seller)) ? 'juice' : 'card';
      filled.push('paid by');
    }
  }
  const total = data.total !== '' && data.total != null ? data.total : sumLines(data.lines);
  if (total !== '' && set('m-amount', total)) filled.push('amount');
  const notes = data.item || summarizePurchase(data.seller, data.lines);
  if (notes && set('m-notes', notes)) filled.push('notes');
  return {data, filled};
}

export function applyOcrFields(raw, overwrite) {
  const data = normalizeOcr(raw);
  if (!data) return null;
  if (session.editKind === 'labour') return applyLabourOcrFields(data, overwrite);
  const set = (id, v) => {
    const el = $(id);
    if (!el || v == null || v === '') return false;
    if (overwrite || !String(el.value || '').trim()) { el.value = v; return true; }
    return false;
  };
  const filled = [];
  const payee = inferPayeeFromOcr(data);
  if (set('m-payee', payee)) filled.push('paid to');
  if (set('m-seller', data.seller)) filled.push('receipt from');
  if (set('m-name', data.seller)) filled.push('name');
  if (set('m-contact', data.contact)) filled.push('contact');
  if (isBankName(data.seller)) {
    const mEl = $('m-method');
    if (mEl && (overwrite || !String(mEl.value || '').trim())) {
      mEl.value = /juice/i.test(String(data.seller)) ? 'juice' : 'card';
      filled.push('paid via');
    }
  }
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
  const manySellers = [...new Set((data.lines || []).map(l => l.seller).filter(Boolean))].length > 1;
  const sum = sumLines(data.lines);
  const total = data.total !== '' && data.total != null ? data.total : sum;
  if (!manySellers && total !== '' && $('m-price') && (overwrite || !String($('m-price').value || '').trim())) {
    $('m-price').value = total;
    filled.push('total');
  }
  const summary = data.item || summarizePurchase(data.seller, data.lines);
  const itemEl = $('m-item');
  if (!manySellers && itemEl && summary && (overwrite || !String(itemEl.value || '').trim() || itemEl.dataset.autogen === '1')) {
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
  return pendingPhotos().map(ph => ocrSrc(ph)).filter(Boolean);
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
  const photos = pendingPhotos();
  const noun = photoNoun();
  const isSeller = session.editKind === 'sellers';
  const isLabour = session.editKind === 'labour';
  if (!photos.length) { ocrStatus('Take or upload a ' + noun + ' photo first.', true); return; }
  const btn = $('m-ocr');
  if (btn) btn.disabled = true;
  ocrStatus('Reading ' + photos.length + ' ' + noun + ' page' + (photos.length === 1 ? '' : 's') + ' with ' + (settings.provider === 'custom' ? (settings.model || 'custom model') : settings.provider) + '…', false);
  hub.setProcessing('Reading receipt with AI…');
  try {
    const extra = isSeller
      ? 'This photo may be a supplier quote. Always fill "seller" and "contact" for THIS photo only. Different photos can be different shops.'
      : isLabour
        ? 'This is a contractor/labour payment proof — cash receipt, service invoice, or MCB/Juice/bank transfer screenshot. "seller" = contractor or person who received the payment (Transfer to / Paid to / Beneficiary), NEVER the bank name. "summary" = work paid for (e.g. foundation pour, plumbing rough-in). "category" = construction trade. "total" = amount paid. Use one line in "lines" if there is no itemized breakdown.'
        : '';
    const merged = {seller: '', contact: '', date: '', receipt: '', category: '', categories: [], total: '', item: '', lines: []};
    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      ocrStatus('Reading page ' + (i + 1) + ' of ' + photos.length + '…', false);
      const raw = await callVisionOCR(ocrSrc(ph), extra);
      const d = normalizeOcr(raw);
      if (!d) continue;
      if (ph) {
        ph.ocrSeller = d.seller || '';
        ph.ocrContact = d.contact || '';
      }
      (d.lines || []).forEach(l => {
        if (!l.seller) l.seller = d.seller || '';
        if (!l.contact) l.contact = d.contact || '';
        l.photoIndex = i;
      });
      if (!merged.seller && d.seller) merged.seller = d.seller;
      if (!merged.contact && d.contact) merged.contact = d.contact;
      if (!merged.date && d.date) merged.date = d.date;
      if (!merged.receipt && d.receipt) merged.receipt = d.receipt;
      if (!merged.category && d.category) merged.category = d.category;
      if (Array.isArray(d.categories)) merged.categories.push(...d.categories);
      if (!merged.item && d.item) merged.item = d.item;
      if (Array.isArray(d.lines) && d.lines.length) merged.lines.push(...d.lines);
    }
    if (isSeller) {
      photos.forEach((ph, i) => {
        if (!ph || !ph.ocrSeller) return;
        if (merged.lines.some(l => Number(l.photoIndex) === i)) return;
        merged.lines.push({
          item: '', qty: '', rate: '', amount: '', category: '',
          seller: ph.ocrSeller, contact: ph.ocrContact || '', photoIndex: i
        });
      });
    }
    const sellerNames = [...new Set(
      merged.lines.map(l => l.seller).concat(photos.map(ph => ph && ph.ocrSeller)).filter(Boolean)
    )];
    if (isSeller) {
      merged.seller = sellerNames.length === 1 ? sellerNames[0] : '';
      const contacts = [...new Set(merged.lines.map(l => l.contact).concat(photos.map(ph => ph && ph.ocrContact)).filter(Boolean))];
      merged.contact = contacts.length === 1 ? contacts[0] : '';
      if (sellerNames.length > 1) merged.item = ($('m-item') && String($('m-item').value || '').trim()) || '';
    }
    merged.categories = [...new Set(merged.categories.concat(merged.lines.map(l => l.category)).filter(Boolean))];
    if (!merged.item) merged.item = summarizePurchase(merged.seller, merged.lines);
    const result = applyOcrFields(merged, !!overwrite);
    const n = result && result.data && result.data.lines ? result.data.lines.length : 0;
    const who = ($('m-seller') && $('m-seller').value) || ($('m-name') && $('m-name').value) || ($('m-payee') && $('m-payee').value) || ('the ' + noun);
    if (isLabour) {
      const amt = $('m-amount') && $('m-amount').value;
      if (!($('m-payee') && $('m-payee').value) && !amt) {
        ocrStatus('AI could not read this payment proof. Fill the fields yourself, or tap Re-scan.', true);
      } else {
        ocrStatus('Filled from ' + who + (amt ? (' · ' + amt + ' Rs') : '') + '. Correct anything that’s wrong, then Save.', false);
      }
    } else if (!n && !($('m-seller') && $('m-seller').value) && !($('m-name') && $('m-name').value) && !sellerNames.length && !($('m-price') && $('m-price').value)) {
      ocrStatus('AI could not read line items from these photos. Type them into the table, or tap Re-scan.', true);
    } else if (isSeller && sellerNames.length > 1) {
      ocrStatus('Found ' + sellerNames.length + ' shops in ' + photos.length + ' photos · ' + n + ' line' + (n === 1 ? '' : 's') + '. Name and contact are on each row. Save creates one seller per shop.', false);
    } else {
      ocrStatus('Filled the table from ' + who + ' · ' + photos.length + ' page' + (photos.length === 1 ? '' : 's') + (n ? (' · ' + n + ' line' + (n === 1 ? '' : 's')) : '') + '. Correct anything that’s wrong, then Save.', false);
    }
  } catch (err) {
    console.error(err);
    ocrStatus('Couldn\'t read ' + noun + ': ' + (err.message || 'error') + '. Keep the photo and fill the table yourself.', true);
  }
  hub.clearProcessing();
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
  if (pendingPhotos().length) { await runOCR(true); return; }
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

export function readSellerQuoteGroups(defaults) {
  const fallbackName = (defaults && defaults.name) || '';
  const fallbackContact = (defaults && defaults.contact) || '';
  const groups = [];
  const indexByKey = new Map();
  const unnamed = [];
  readLinesFromTable().forEach(l => {
    const name = String(l.seller || fallbackName).trim();
    const contact = String(l.contact || fallbackContact).trim();
    const key = sellerNameKey(name);
    const photoRaw = l.photoIndex;
    const photoIndex = photoRaw !== '' && photoRaw != null && !Number.isNaN(Number(photoRaw)) ? Number(photoRaw) : '';
    const line = {
      item: l.item, qty: l.qty, rate: l.rate, amount: l.amount,
      seller: name, contact
    };
    if (!key) {
      unnamed.push(line);
      return;
    }
    if (!indexByKey.has(key)) {
      indexByKey.set(key, groups.length);
      groups.push({key, name, contact, lines: [], photoIndexes: []});
    }
    const g = groups[indexByKey.get(key)];
    g.contact = mergeContact(g.contact, contact);
    g.lines.push(line);
    if (photoIndex !== '') g.photoIndexes.push(photoIndex);
  });
  if (unnamed.length && groups.length) {
    const g = groups[0];
    unnamed.forEach(line => {
      line.seller = g.name;
      line.contact = line.contact || g.contact;
      g.lines.push(line);
    });
    unnamed.length = 0;
  }
  return {groups, unnamed};
}

export function readPurchaseForm() {
  const lines = readLinesFromTable();
  const payee = ($('m-payee') && $('m-payee').value.trim()) || '';
  const seller = ($('m-seller') && $('m-seller').value.trim()) || '';
  const date = ($('m-date') && $('m-date').value) || '';
  const receipt = ($('m-receipt') && $('m-receipt').value.trim()) || '';
  const categories = readSelectedCategories();
  const category = categories[0] || '';
  const lineSum = sumLines(lines);
  let price = lineSum || parseMoney($('m-price') && $('m-price').value);
  const item = (($('m-item') && $('m-item').value.trim()) || summarizePurchase(payee || seller, lines)).trim();
  return {lines, seller, payee, date, receipt, category, categories, price, item};
}

function inferPayeeFromOcr(data) {
  const seller = String(data.seller || '').trim();
  if (seller && !isBankName(seller)) return seller;
  for (const l of data.lines || []) {
    const it = String(l.item || '').trim();
    if (it && !isBankName(it) && it.length > 2) return it;
  }
  const item = String(data.item || '').trim();
  if (item && !isBankName(item)) return item.replace(/^(inv[-\s#]?[\d\w./+-]+[\s:+\-–]*)/i, '').trim() || item;
  return '';
}
