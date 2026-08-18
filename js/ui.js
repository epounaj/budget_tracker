import {TITLES, CHIP} from './config.js';
import {state, settings, session, persist, saveSettings} from './store.js';
import {$, esc, money, todayStr, uid, finiteNum, toast, normalizeCategory} from './util.js';
import {hub} from './hub.js';
import {providerOptionsHtml, modelPickerHtml, wireModelPicker, readModelValue, chatCompletionsUrl} from './ai.js';
import {handlePhoto, maybeScanAfterPhoto, startReceiptScan, removePendingPhoto, openPhotoLightbox, clearPendingPhoto} from './receipts.js';
import {driveApiEnableUrl, ensureDriveFolder, saveProfileToDrive, deleteDriveFile, uploadOriginalToDrive, scheduleCsvSync, syncCsvToDrive, updateSyncPill, pullCsvFromDrive} from './drive.js';
import {downloadCSV, importCSVFile} from './csv.js';
import {googleLogout} from './auth.js';

const chip = s => { const m = CHIP[s] || ['pending', s || '—']; return '<span class="chip ' + m[0] + '">' + m[1] + '</span>'; };

function loanReceived() { return state.funds.filter(f => f.type === 'loan').reduce((s, f) => s + (+f.amount || 0), 0); }
function ownCash() { return state.funds.filter(f => f.type === 'cash').reduce((s, f) => s + (+f.amount || 0), 0); }
function totalSpent() { return state.purchases.reduce((s, p) => s + (+p.price || 0), 0); }
function spentForCat(c) { return state.purchases.filter(p => (p.category || '').toLowerCase() === String(c || '').toLowerCase()).reduce((s, p) => s + (+p.price || 0), 0); }

function computeSummary() {
  const loan = loanReceived(), cash = ownCash(), spent = totalSpent(), avail = loan + cash - spent;
  const av = $('avail-value');
  av.textContent = money(avail);
  av.classList.toggle('negative', avail < 0);
  $('stat-loan').textContent = money(loan);
  $('stat-cash').textContent = money(cash);
  $('stat-spent').textContent = money(spent);
  $('stat-pending').textContent = state.actions.filter(a => a.status !== 'done').length;
}

function head(title, desc, kind) {
  return '<div class="panel-head"><div><p class="panel-title">' + title + '</p><p class="panel-desc">' + desc + '</p></div>' +
    '<button class="add-btn" data-add="' + kind + '"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add</button></div>';
}
function empty(b, s) { return '<div class="empty-state"><p class="big">' + b + '</p><p class="small">' + s + '</p></div>'; }

function renderFunds() {
  const sorted = [...state.funds].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const items = sorted.map(f => '<div class="entry"><div class="entry-top"><div>' +
    '<p class="entry-name">' + esc(f.label || (f.type === 'loan' ? 'Loan tranche' : 'Own cash')) + '</p>' +
    '<p class="entry-sub">' + (f.type === 'loan' ? '<span class="tag">Loan phase</span>' : '<span class="tag">Own cash</span>') + ' &nbsp;' + esc(f.date || '') + '</p></div>' +
    '<span class="entry-amount" style="color:' + (f.type === 'loan' ? 'var(--loan)' : 'var(--ink)') + '">+' + money(f.amount) + '</span></div>' +
    (f.notes ? '<div class="entry-meta"><span class="meta-item">' + esc(f.notes) + '</span></div>' : '') +
    '<div class="entry-actions"><button class="icon-btn" data-edit="funds" data-id="' + f.id + '">Edit</button>' +
    '<button class="icon-btn danger" data-del="funds" data-id="' + f.id + '">Delete</button></div></div>').join('');
  return head('Funds', 'Log each loan tranche as it lands, plus any own cash. Spending is deducted automatically.', 'funds') +
    (state.funds.length ? '<div class="entry-list">' + items + '</div>' : empty('No funds recorded yet', 'Add your first loan phase or own-cash contribution.'));
}
function renderBudget() {
  const items = state.budget.map(b => {
    const spent = spentForCat(b.category), bud = +b.budgeted || 0, remain = bud - spent, w = bud > 0 ? Math.min(100, spent / bud * 100) : 0;
    return '<div class="entry"><div class="entry-top"><div><p class="entry-name">' + esc(b.category) + '</p>' +
      (b.notes ? '<p class="entry-sub">' + esc(b.notes) + '</p>' : '') + '</div><span class="entry-amount">' + money(bud) + '</span></div>' +
      '<div class="entry-meta"><span class="meta-item">Spent <strong>' + money(spent) + '</strong></span>' +
      '<span class="meta-item">Remaining <strong style="color:' + (remain < 0 ? 'var(--spend)' : 'var(--accent)') + '">' + money(remain) + '</strong></span></div>' +
      '<div class="bar"><span class="' + (spent > bud ? 'over' : '') + '" style="width:' + w + '%"></span></div>' +
      '<div class="entry-actions"><button class="icon-btn" data-edit="budget" data-id="' + b.id + '">Edit</button>' +
      '<button class="icon-btn danger" data-del="budget" data-id="' + b.id + '">Delete</button></div></div>';
  }).join('');
  return head('Budget by category', 'Plan what each part should cost. Actual spend fills in from purchases.', 'budget') +
    (state.budget.length ? '<div class="entry-list">' + items + '</div>' : empty('No budget categories yet', 'Add a category like "Roofing" with a planned amount.'));
}
function renderActions() {
  const sorted = [...state.actions].sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    return (a.due || '').localeCompare(b.due || '');
  });
  const items = sorted.map(a => '<div class="entry"><div class="entry-top"><div><p class="entry-name">' + esc(a.title) + '</p>' +
    (a.notes ? '<p class="entry-sub">' + esc(a.notes) + '</p>' : '') + '</div>' + chip(a.status) + '</div>' +
    (a.due ? '<div class="entry-meta"><span class="meta-item">Due <strong>' + esc(a.due) + '</strong></span></div>' : '') +
    '<div class="entry-actions">' + (a.status !== 'done' ? '<button class="icon-btn good" data-done="' + a.id + '">Mark done</button>' : '') +
    '<button class="icon-btn" data-edit="actions" data-id="' + a.id + '">Edit</button>' +
    '<button class="icon-btn danger" data-del="actions" data-id="' + a.id + '">Delete</button></div></div>').join('');
  return head('Pending actions', 'What still needs doing, and when.', 'actions') +
    (state.actions.length ? '<div class="entry-list">' + items + '</div>' : empty('No actions yet', 'Add things like "Get quote for tiles".'));
}
function renderSellers() {
  const items = state.sellers.map(s => '<div class="entry"><div class="entry-top"><div><p class="entry-name">' + esc(s.name) + '</p>' +
    (s.contact ? '<p class="entry-sub">' + esc(s.contact) + '</p>' : '') + '</div>' + chip(s.status) + '</div>' +
    '<div class="entry-meta">' + (s.item ? '<span class="meta-item">' + esc(s.item) + '</span>' : '') +
    ((s.price !== '' && s.price != null) ? '<span class="meta-item">Quoted <strong>' + money(s.price) + '</strong></span>' : '') +
    (s.notes ? '<span class="meta-item">' + esc(s.notes) + '</span>' : '') + '</div>' +
    '<div class="entry-actions"><button class="icon-btn" data-edit="sellers" data-id="' + s.id + '">Edit</button>' +
    '<button class="icon-btn danger" data-del="sellers" data-id="' + s.id + '">Delete</button></div></div>').join('');
  return head('Seller shortlist', 'Compare suppliers and contractors you\'re considering.', 'sellers') +
    (state.sellers.length ? '<div class="entry-list">' + items + '</div>' : empty('No sellers shortlisted yet', 'Add suppliers with their quoted price and status.'));
}
function renderPurchases() {
  const sorted = [...state.purchases].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const items = sorted.map(p => '<div class="entry"><div class="entry-top" style="gap:12px">' +
    (p.thumb ? '<img src="' + p.thumb + '" class="thumb" data-lightbox="' + p.id + '" alt="Receipt">' : '') +
    '<div style="flex:1"><p class="entry-name">' + esc(p.item) + '</p>' +
    '<p class="entry-sub">' + (p.seller ? esc(p.seller) : '') + ((p.seller && p.date) ? ' · ' : '') + (p.date ? esc(p.date) : '') + '</p></div>' +
    '<span class="entry-amount">' + money(p.price) + '</span></div>' +
    '<div class="entry-meta">' + (p.category ? '<span class="tag">' + esc(p.category) + '</span>' : '') +
    (p.receipt ? '<span class="meta-item">Receipt <strong>' + esc(p.receipt) + '</strong></span>' : '') +
    (p.driveLink ? '<a class="meta-item" href="' + esc(p.driveLink) + '" target="_blank" rel="noopener">' + (p.driveFolder ? esc(p.driveFolder) : 'Original on Drive') + '</a>' : (p.thumb ? '<span class="meta-item">Photo</span>' : '')) + '</div>' +
    '<div class="entry-actions"><button class="icon-btn" data-edit="purchases" data-id="' + p.id + '">Edit</button>' +
    '<button class="icon-btn danger" data-del="purchases" data-id="' + p.id + '">Delete</button></div></div>').join('');
  return head('Purchases &amp; receipts', 'Camera or Gallery scans with AI. Correct the fields, then Save. The original photo is kept.', 'purchases') +
    (state.purchases.length ? '<div class="entry-list">' + items + '</div>' : empty('No purchases logged yet', 'Take a photo or pick from the gallery. Save stays at the bottom.'));
}

export function render() {
  computeSummary();
  $('panel-root').innerHTML = ({funds: renderFunds, budget: renderBudget, actions: renderActions, sellers: renderSellers, purchases: renderPurchases}[session.activeTab])();
  attach();
  updateSyncPill();
}

function attach() {
  const root = $('panel-root');
  root.querySelectorAll('[data-add]').forEach(b => b.onclick = () => openModal(b.dataset.add, null));
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const k = b.dataset.edit;
    const r = state[k].find(x => x.id === b.dataset.id);
    if (r) openModal(k, r);
  });
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const k = b.dataset.del;
    if (!confirm('Delete this entry?')) return;
    state[k] = state[k].filter(x => x.id !== b.dataset.id);
    await persist(k);
    render();
    if (settings.driveToken) scheduleCsvSync();
  });
  root.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
    const it = state.actions.find(a => a.id === b.dataset.done);
    if (it) { it.status = 'done'; await persist('actions'); render(); if (settings.driveToken) scheduleCsvSync(); }
  });
  root.querySelectorAll('[data-lightbox]').forEach(im => im.onclick = () => {
    const r = state.purchases.find(x => x.id === im.dataset.lightbox);
    if (r && r.driveLink) { window.open(r.driveLink, '_blank', 'noopener'); return; }
    if (r && r.thumb) { $('lightbox-img').src = r.thumb; $('lightbox').classList.add('show'); }
  });
}

function formBody(kind, p) {
  if (kind === 'funds') {
    p = p || {type: 'loan', label: '', amount: '', date: todayStr(), notes: ''};
    return '<div class="form-grid">' +
      '<div class="field"><label class="req">Amount (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-amount" value="' + esc(p.amount) + '" placeholder="e.g. 500000"></div>' +
      '<div class="field"><label>Source</label><select id="m-type"><option value="loan"' + (p.type === 'loan' ? ' selected' : '') + '>Loan phase</option><option value="cash"' + (p.type === 'cash' ? ' selected' : '') + '>Own cash</option></select></div>' +
      '<div class="field"><label>Date</label><input type="date" id="m-date" value="' + esc(p.date || todayStr()) + '"></div>' +
      '<div class="field"><label>Label</label><input id="m-label" value="' + esc(p.label) + '" placeholder="e.g. Phase 1"></div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="Optional"></div></div>';
  }
  if (kind === 'budget') {
    p = p || {category: '', budgeted: '', notes: ''};
    return '<div class="form-grid">' +
      '<div class="field"><label class="req">Category</label><input list="category-options" id="m-category" value="' + esc(p.category) + '" placeholder="Roofing, Kitchen…"></div>' +
      '<div class="field"><label class="req">Planned (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-budgeted" value="' + esc(p.budgeted) + '" placeholder="e.g. 200000"></div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="Optional"></div></div>';
  }
  if (kind === 'actions') {
    p = p || {title: '', due: '', status: 'pending', notes: ''};
    return '<div class="form-grid">' +
      '<div class="field wide"><label class="req">Task</label><input id="m-title" value="' + esc(p.title) + '" placeholder="e.g. Get quote for tiles"></div>' +
      '<div class="field"><label>Due</label><input type="date" id="m-due" value="' + esc(p.due) + '"></div>' +
      '<div class="field"><label>Status</label><select id="m-status">' +
      '<option value="pending"' + (p.status === 'pending' ? ' selected' : '') + '>Pending</option>' +
      '<option value="progress"' + (p.status === 'progress' ? ' selected' : '') + '>In progress</option>' +
      '<option value="done"' + (p.status === 'done' ? ' selected' : '') + '>Done</option></select></div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="Optional"></div></div>';
  }
  if (kind === 'sellers') {
    p = p || {name: '', contact: '', item: '', price: '', status: 'shortlisted', notes: ''};
    return '<div class="form-grid">' +
      '<div class="field wide"><label class="req">Name</label><input id="m-name" value="' + esc(p.name) + '" placeholder="e.g. ABC Hardware" autocomplete="off"></div>' +
      '<div class="field"><label>For</label><input list="category-options" id="m-item" value="' + esc(p.item) + '" placeholder="e.g. Roof tiles"></div>' +
      '<div class="field"><label>Quoted (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-price" value="' + esc(p.price) + '" placeholder="Optional"></div>' +
      '<div class="field"><label>Contact</label><input id="m-contact" value="' + esc(p.contact) + '" placeholder="Optional" autocomplete="off"></div>' +
      '<div class="field"><label>Status</label><select id="m-status">' +
      '<option value="shortlisted"' + (p.status === 'shortlisted' ? ' selected' : '') + '>Shortlisted</option>' +
      '<option value="contacted"' + (p.status === 'contacted' ? ' selected' : '') + '>Contacted</option>' +
      '<option value="selected"' + (p.status === 'selected' ? ' selected' : '') + '>Selected</option>' +
      '<option value="rejected"' + (p.status === 'rejected' ? ' selected' : '') + '>Rejected</option></select></div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="Optional"></div></div>';
  }
  if (kind === 'purchases') {
    p = p || {item: '', category: '', seller: '', price: '', date: todayStr(), receipt: '', thumb: null};
    const cur = (session.pending && (session.pending.previewUrl || session.pending.thumbDataUrl)) || p.thumb;
    const hasKey = !!settings.apiKey;
    return '<div class="photo-field" style="margin-bottom:14px">' +
      '<div class="photo-actions">' +
      '<label class="photo-btn"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>Camera' +
      '<input type="file" accept="image/*" capture="environment" id="m-photo-cam" style="display:none"></label>' +
      '<label class="photo-btn"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>Gallery' +
      '<input type="file" accept="image/*" id="m-photo" style="display:none"></label></div>' +
      '<p class="field-hint">AI reads the receipt. You can edit every field. Save stays visible at the bottom. The original photo is uploaded to Drive.</p>' +
      (hasKey ? '' : '<div class="inline-ai" id="inline-ai"><p>Paste your AI key once so scan can run. It is saved to your Drive profile.</p>' +
        '<div class="form-grid">' +
        '<div class="field"><label>Provider</label><select id="m-ai-provider">' + providerOptionsHtml() + '</select></div>' +
        '<div class="field"><label>API key</label><input id="m-ai-key" type="password" placeholder="sk-… or your provider key" autocomplete="off"></div></div>' +
        '<div id="m-ai-custom" style="display:none;margin-top:10px">' +
        '<div class="field wide"><label class="req">API base URL</label><input id="m-ai-base" value="' + esc(settings.apiBase) + '" placeholder="https://api.example.com/v1" autocomplete="off"></div></div>' +
        modelPickerHtml('m-ai') + '</div>') +
      '<button type="button" class="ocr-btn" id="m-ocr" style="margin-top:10px"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg>' + (hasKey ? 'Re-scan with AI' : 'Scan receipt') + '</button>' +
      '<div class="ocr-status" id="m-ocr-status"></div>' +
      '<div class="photo-preview ' + (cur ? 'show' : '') + '" id="m-photo-preview"><img id="m-photo-img" src="' + (cur || '') + '" alt="Receipt">' +
      '<div class="photo-preview-meta"><p class="field-hint" id="m-photo-meta">' + (cur ? 'Photo attached. Tap it to view larger. Correct fields below, then Save.' : '') + '</p>' +
      '<button type="button" class="photo-remove" id="m-photo-remove">Remove photo</button></div></div></div>' +
      '<div class="form-grid">' +
      '<div class="field"><label class="req">Price (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-price" value="' + esc(p.price) + '" placeholder="What you paid"></div>' +
      '<div class="field"><label class="req">Item</label><input id="m-item" value="' + esc(p.item) + '" placeholder="e.g. 50 bags cement"></div>' +
      '<div class="field"><label>Category</label><input list="category-options" id="m-category" value="' + esc(p.category) + '" placeholder="Foundation…"></div>' +
      '<div class="field"><label>Seller</label><input id="m-seller" value="' + esc(p.seller) + '" placeholder="Who you bought from"></div>' +
      '<div class="field"><label>Date</label><input type="date" id="m-date" value="' + esc(p.date || todayStr()) + '"></div>' +
      '<div class="field"><label>Receipt no.</label><input id="m-receipt" value="' + esc(p.receipt) + '" placeholder="Optional"></div></div>';
  }
  return '';
}

export function openModal(kind, rec) {
  session.editKind = kind;
  session.editing = rec || null;
  session.photoCleared = false;
  clearPendingPhoto();
  const title = (rec ? TITLES[kind][1] : TITLES[kind][0]);
  const sub = {
    funds: 'How much came in, and from where.',
    budget: 'A category and the amount you planned for it.',
    actions: 'One thing still to do. Due date is optional.',
    sellers: 'A supplier and their quote, if you have it.',
    purchases: 'Take or upload a receipt. AI fills the fields — you can correct them. Save stays at the bottom.'
  }[kind];
  $('modal').innerHTML =
    '<div class="modal-head"><p class="modal-title">' + title + '</p>' +
    '<button class="modal-close" id="modal-close" aria-label="Close">&times;</button></div>' +
    '<p class="modal-sub">' + sub + '</p>' +
    '<div class="modal-body">' + formBody(kind, rec) + '<p class="error-text" id="modal-error"></p></div>' +
    '<div class="modal-actions"><button class="btn-primary" id="modal-save">' + (rec ? 'Save changes' : 'Save') + '</button>' +
    '<button class="btn-cancel" id="modal-cancel">Cancel</button></div>';
  $('overlay').classList.add('show');
  bindModal();
  if (kind !== 'purchases') setTimeout(() => {
    const el = $('m-amount') || $('m-title') || $('m-name');
    if (el) el.focus();
  }, 40);
}

export function closeModal() {
  $('overlay').classList.remove('show');
  session.editing = null;
  session.editKind = null;
  session.photoCleared = false;
  clearPendingPhoto();
}

function bindModal() {
  $('modal-close').onclick = closeModal;
  $('modal-cancel').onclick = closeModal;
  $('modal-save').onclick = saveModal;
  $('modal').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target || e.target.id === 'modal-save') return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.target.closest && e.target.closest('#inline-ai')) return;
    e.preventDefault();
    saveModal();
  });
  const onFile = async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    await handlePhoto(f);
    await maybeScanAfterPhoto();
    e.target.value = '';
  };
  const pin = $('m-photo'); if (pin) pin.addEventListener('change', onFile);
  const cam = $('m-photo-cam'); if (cam) cam.addEventListener('change', onFile);
  const prm = $('m-photo-remove'); if (prm) prm.onclick = removePendingPhoto;
  const ocr = $('m-ocr'); if (ocr) ocr.onclick = startReceiptScan;
  const img = $('m-photo-img'); if (img) img.onclick = openPhotoLightbox;
  wireModelPicker('m-ai', 'm-ai-custom');
}

function showErr(msg) {
  const e = $('modal-error');
  e.textContent = msg;
  e.classList.add('show');
}

async function saveModal() {
  const k = session.editKind, val = id => { const el = $(id); return el ? el.value : ''; };
  let obj;
  if (k === 'funds') {
    const a = val('m-amount');
    if (!finiteNum(a) || +a < 0) return showErr('Enter a valid amount.');
    obj = {type: val('m-type'), label: val('m-label').trim(), amount: +a, date: val('m-date') || todayStr(), notes: val('m-notes').trim()};
  } else if (k === 'budget') {
    const c = val('m-category').trim(), b = val('m-budgeted');
    if (!c || !finiteNum(b) || +b < 0) return showErr('Enter a category and a valid budgeted amount.');
    obj = {category: c, budgeted: +b, notes: val('m-notes').trim()};
  } else if (k === 'actions') {
    const t = val('m-title').trim();
    if (!t) return showErr('Enter a task name.');
    obj = {title: t, due: val('m-due'), status: val('m-status'), notes: val('m-notes').trim()};
  } else if (k === 'sellers') {
    const n = val('m-name').trim();
    if (!n) return showErr('Enter a seller name.');
    const pr = val('m-price');
    if (pr !== '' && (!finiteNum(pr) || +pr < 0)) return showErr('Enter a valid quoted price, or leave it blank.');
    obj = {name: n, contact: val('m-contact').trim(), item: val('m-item').trim(), price: pr === '' ? '' : +pr, status: val('m-status'), notes: val('m-notes').trim()};
  } else if (k === 'purchases') {
    const it = val('m-item').trim(), pr = val('m-price');
    if (!it || !finiteNum(pr) || +pr < 0) return showErr('Enter an item name and a valid price.');
    const cat = normalizeCategory(val('m-category').trim()) || 'Uncategorized';
    const pending = session.pending;
    const thumb = session.photoCleared ? null : ((pending && pending.thumbDataUrl) || (session.editing ? session.editing.thumb : null) || null);
    obj = {
      item: it,
      category: cat === 'Uncategorized' && !val('m-category').trim() ? '' : cat,
      seller: val('m-seller').trim(),
      price: +pr,
      date: val('m-date') || todayStr(),
      receipt: val('m-receipt').trim(),
      thumb
    };
    if (pending && pending.originalFile && settings.driveToken) {
      try {
        if (session.editing && session.editing.driveFileId) await deleteDriveFile(session.editing.driveFileId);
        const link = await uploadOriginalToDrive(pending.originalFile, {
          item: it, category: obj.category, seller: obj.seller, date: obj.date, receipt: obj.receipt, ext: pending.ext
        });
        if (link) { obj.driveLink = link.webViewLink; obj.driveFileId = link.id; obj.driveFolder = link.folderPath || ''; }
      } catch (e) {
        return showErr('Could not upload the original photo to Drive. Enable Drive API if needed, then tap Save again. The photo is still attached.');
      }
    } else if (pending && pending.originalFile && !settings.driveToken) {
      toast('Saved on this device. Sign in to keep the original photo in Drive.');
    } else if (session.photoCleared) {
      obj.driveLink = null; obj.driveFileId = null; obj.driveFolder = null;
    } else if (session.editing && session.editing.driveLink) {
      obj.driveLink = session.editing.driveLink;
      obj.driveFileId = session.editing.driveFileId;
      obj.driveFolder = session.editing.driveFolder;
    }
  }
  if (session.editing) Object.assign(session.editing, obj);
  else { obj.id = uid(); state[k].push(obj); }
  await persist(k);
  closeModal();
  render();
  if (settings.driveToken) scheduleCsvSync();
}

export function renderSettings() {
  const who = settings.user ? (settings.user.name || settings.user.email) : '';
  $('settings-modal').innerHTML =
    '<div class="modal-head"><p class="modal-title">Settings</p><button class="modal-close" id="set-close">&times;</button></div>' +
    '<div class="modal-body">' +
    '<div class="set-section"><h3>Google account</h3><p class="hint">' + (who ? 'Signed in as <b>' + esc(who) + '</b>.' : 'Not signed in.') + '</p>' +
    '<div class="set-row"><button class="set-btn accent" id="drive-syncnow">Sync now</button>' +
    '<button class="set-btn" id="drive-reload">Reload from Drive</button>' +
    '<button class="set-btn" id="drive-create">Create Drive folder</button>' +
    '<a class="set-btn" id="drive-enable-api" href="' + esc(driveApiEnableUrl()) + '" target="_blank" rel="noopener">Enable Drive API</a>' +
    (settings.driveFolderId ? '<a class="set-btn" id="drive-open" href="https://drive.google.com/drive/folders/' + esc(settings.driveFolderId) + '" target="_blank" rel="noopener">Open Drive folder</a>' : '') +
    '<button class="set-btn" id="google-logout">Sign out</button></div>' +
    '<div class="set-note">Phone and PC share <b>My Drive → Site Ledger → site-ledger.csv</b> when you sign in with the same Google account. Use the same site URL on both (<a href="https://epounaj.github.io/budget_tracker/" target="_blank" rel="noopener">GitHub Pages</a>). Layout looks different on a small screen; the numbers should match after sync.</div></div>' +
    '<div class="set-section"><h3>AI receipt scanning</h3><p class="hint">Paste your own key for OpenAI, Qwen, DeepSeek, or any OpenAI-compatible API. Saved to your Drive profile.</p>' +
    '<div class="field" style="margin-bottom:10px"><label>Provider</label><select id="set-provider">' + providerOptionsHtml() + '</select></div>' +
    '<div id="set-custom" style="display:none">' +
    '<div class="field" style="margin-bottom:10px"><label class="req">API base URL</label><input id="set-base" value="' + esc(settings.apiBase) + '" placeholder="https://api.example.com/v1" autocomplete="off">' +
    '<p class="field-hint">Use the /v1 root or the full /v1/chat/completions URL.</p></div></div>' +
    '<div class="field" style="margin-bottom:10px"><label>API key</label><input id="set-key" type="password" value="' + esc(settings.apiKey) + '" placeholder="sk-… or your provider key" autocomplete="off"></div>' +
    modelPickerHtml('set') +
    '<div class="set-note">Provider, key, chosen model, and the model list are saved to <b>your</b> Google Drive profile.</div></div>' +
    '<div class="set-section"><h3>Manual backup (CSV)</h3><p class="hint">Export a local copy, or import to replace current data.</p>' +
    '<div class="set-row"><button class="set-btn" id="csv-export">Export CSV</button>' +
    '<button class="set-btn" id="csv-import">Import CSV</button>' +
    '<input type="file" accept=".csv,text/csv" id="csv-file" style="display:none"></div></div></div>' +
    '<div class="modal-actions"><button class="btn-primary" id="set-save">Save settings</button></div>';
  $('set-close').onclick = () => $('settings-overlay').classList.remove('show');
  wireModelPicker('set', 'set-custom');
  $('set-save').onclick = async () => {
    settings.provider = $('set-provider').value;
    settings.apiKey = $('set-key').value.trim();
    settings.model = readModelValue('set');
    const baseEl = $('set-base'); if (baseEl) settings.apiBase = baseEl.value.trim();
    const modelSel = $('set-model');
    if (modelSel && Array.isArray(modelSel._allModels) && modelSel._allModels.length) settings.models = modelSel._allModels.slice(0, 400);
    if (settings.provider === 'custom') {
      if (!settings.apiBase) { toast('Enter the custom API base URL'); return; }
      if (!settings.model) { toast('Choose a model, or tap Other to type one'); return; }
      try { chatCompletionsUrl(settings.apiBase); } catch (e) { toast(e.message); return; }
    }
    await saveSettings();
    try { await saveProfileToDrive(); toast('Saved to your Google profile'); }
    catch (e) { toast(e.message || 'Saved on this device only'); }
    updateSyncPill();
    $('settings-overlay').classList.remove('show');
  };
  $('csv-export').onclick = downloadCSV;
  $('csv-import').onclick = () => $('csv-file').click();
  $('csv-file').onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importCSVFile(f); };
  const ds = $('drive-syncnow'); if (ds) ds.onclick = syncCsvToDrive;
  const dr = $('drive-reload');
  if (dr) dr.onclick = async () => {
    try { await pullCsvFromDrive(); }
    catch (e) { toast(e.message || 'Could not load from Drive'); }
  };
  const mk = $('drive-create');
  if (mk) mk.onclick = async () => {
    try {
      await ensureDriveFolder();
      await saveProfileToDrive();
      await saveSettings();
      toast('Folder ready: My Drive → Site Ledger');
      renderSettings();
    } catch (e) { toast(e.message || 'Could not create Drive folder'); }
  };
  const lo = $('google-logout'); if (lo) lo.onclick = googleLogout;
}

export function bindShell() {
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab-btn');
    if (!b) return;
    session.activeTab = b.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === session.activeTab));
    render();
  });
  $('overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  $('lightbox-close').onclick = () => $('lightbox').classList.remove('show');
  $('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('lightbox').classList.remove('show'); });
  $('open-settings').onclick = () => { renderSettings(); $('settings-overlay').classList.add('show'); };
  $('settings-overlay').addEventListener('click', e => { if (e.target.id === 'settings-overlay') $('settings-overlay').classList.remove('show'); });
  $('sync-pill').addEventListener('click', () => {
    if (!settings.driveToken) hub.showLogin();
  });
}

hub.render = render;
hub.updateSyncPill = updateSyncPill;
