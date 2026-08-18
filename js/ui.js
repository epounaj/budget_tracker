import {TITLES, CHIP} from './config.js?v=20260818j';
import {state, settings, session, persist, saveSettings} from './store.js?v=20260818j';
import {$, esc, money, todayStr, uid, finiteNum, toast, normalizeCategory, compressImage, extFromFile} from './util.js?v=20260818j';
import {hub} from './hub.js?v=20260818j';
import {providerOptionsHtml, modelPickerHtml, wireModelPicker, readModelValue, chatCompletionsUrl, callVisionOCR} from './ai.js?v=20260818j';
import {handlePhoto, maybeScanAfterPhoto, startReceiptScan, removePendingPhoto, openPhotoLightbox, clearPendingPhoto, purchaseLinesHtml, bindLineTable, readPurchaseForm, normalizeOcr} from './receipts.js?v=20260818j';
import {driveApiEnableUrl, ensureDriveFolder, saveProfileToDrive, deleteDriveFile, uploadOriginalToDrive, uploadSellerOriginalToDrive, scheduleCsvSync, syncCsvToDrive, updateSyncPill, pullCsvFromDrive} from './drive.js?v=20260818j';
import {downloadCSV, importCSVFile} from './csv.js?v=20260818j';
import {googleLogout, startGoogleLogin} from './auth.js?v=20260818j';

let sellerPendingPhotos = [];
let sellerPendingLines = [];
let sellerItemSearch = '';

function sellerLinesTableHtml(lines) {
  if (!Array.isArray(lines) || !lines.length) return '<p class="field-hint">No extracted line items yet.</p>';
  return '<div class="receipt-table-wrap"><table class="receipt-table"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>' +
    lines.map(l => '<tr><td>' + esc(l.item || '') + '</td><td>' + esc(l.qty || '') + '</td><td>' + money(l.rate || 0) + '</td><td>' + money(l.amount || 0) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

async function extractSellerLinesFromPending(overwrite) {
  const status = $('m-seller-ocr-status');
  if (!sellerPendingPhotos.length || !settings.apiKey) return;
  const merged = [];
  let firstSeller = '', firstCategory = '';
  for (let i = 0; i < sellerPendingPhotos.length; i++) {
    if (status) status.textContent = 'Reading seller image ' + (i + 1) + ' of ' + sellerPendingPhotos.length + '…';
    const ph = sellerPendingPhotos[i];
    try {
      const raw = await callVisionOCR(ph.ocrDataUrl || ph.thumb || ph.url);
      const data = normalizeOcr(raw);
      if (!data) continue;
      if (!firstSeller && data.seller) firstSeller = data.seller;
      if (!firstCategory && data.category) firstCategory = data.category;
      (data.lines || []).forEach(l => {
        const item = String((l && l.item) || '').trim();
        if (!item) return;
        merged.push({
          item,
          qty: Number(l.qty) || 0,
          rate: Number(l.rate) || 0,
          amount: Number(l.amount) || 0
        });
      });
    } catch (e) {}
  }
  if (merged.length && (overwrite || !sellerPendingLines.length)) sellerPendingLines = merged;
  const itemEl = $('m-item');
  if (itemEl && !itemEl.value.trim() && sellerPendingLines[0]) itemEl.value = sellerPendingLines[0].item || '';
  const nameEl = $('m-name');
  if (nameEl && !nameEl.value.trim() && firstSeller) nameEl.value = firstSeller;
  const catEl = $('m-category');
  if (catEl && !catEl.value.trim() && firstCategory) catEl.value = firstCategory;
  const box = $('m-seller-lines');
  if (box) box.innerHTML = sellerLinesTableHtml(sellerPendingLines);
  if (status) status.textContent = sellerPendingLines.length ? ('Extracted ' + sellerPendingLines.length + ' line items from seller images.') : 'Could not extract line items. You can still save manually.';
}

function chip(status) {
  const map = CHIP || {};
  const meta = map[status] || [String(status || 'pending'), String(status || 'Pending')];
  return '<span class="chip ' + esc(meta[0]) + '">' + esc(meta[1]) + '</span>';
}

function parsePurchaseLines(p) {
  if (!p) return [{item: '', qty: '', rate: '', amount: ''}];
  if (Array.isArray(p.lines) && p.lines.length) return p.lines;
  if (p.lines && typeof p.lines === 'string') {
    try {
      const arr = JSON.parse(p.lines);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {}
  }
  if (p.item || p.price) return [{item: p.item || '', qty: '', rate: '', amount: p.price || ''}];
  return [{item: '', qty: '', rate: '', amount: ''}];
}

function loanReceived() { return state.funds.filter(f => f.type === 'loan').reduce((s, f) => s + (+f.amount || 0), 0); }
function ownCash() { return state.funds.filter(f => f.type === 'cash').reduce((s, f) => s + (+f.amount || 0), 0); }
function purchaseTotal(p) {
  const ls = Array.isArray(p.lines) && p.lines.length ? p.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) : 0;
  return ls || +p.price || 0;
}
function totalSpent() { return state.purchases.reduce((s, p) => s + purchaseTotal(p), 0); }
function spentForCat(c) { return state.purchases.filter(p => (p.category || '').toLowerCase() === String(c || '').toLowerCase()).reduce((s, p) => s + purchaseTotal(p), 0); }

function computeSummary() {
  const loan = loanReceived(), cash = ownCash(), spent = totalSpent(), avail = loan + cash - spent;
  const av = $('avail-value');
  if (av) { av.textContent = money(avail); av.classList.toggle('negative', avail < 0); }
  const sl = $('stat-loan'); if (sl) sl.textContent = money(loan);
  const sc = $('stat-cash'); if (sc) sc.textContent = money(cash);
  const ss = $('stat-spent'); if (ss) ss.textContent = money(spent);
  const sp = $('stat-pending'); if (sp) sp.textContent = state.actions.filter(a => a.status !== 'done').length;
}

function head(title, desc, kind) {
  return '<div class="panel-head"><div><p class="panel-title">' + title + '</p><p class="panel-desc">' + desc + '</p></div>' +
    '<button class="add-btn" data-add="' + kind + '"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add</button></div>';
}
function empty(b, s) { return '<div class="empty-state"><p class="big">' + b + '</p><p class="small">' + s + '</p></div>'; }

function renderDashboard() {
  const loan = loanReceived(), cash = ownCash(), spent = totalSpent(), avail = loan + cash - spent;
  const total = loan + cash;

  // Summary cards
  let html = '<div class="summary">' +
    '<div class="avail-block"><div><p class="avail-label">Available funds now</p>' +
    '<p class="avail-value' + (avail < 0 ? ' negative' : '') + '" id="avail-value">' + money(avail) + '</p></div>' +
    '<p class="avail-hint">Loan received + own cash − everything spent</p></div>' +
    '<div class="stat-grid">' +
    '<div><p class="stat-label"><span class="stat-dot" style="background:var(--loan)"></span>Loan received</p><p class="stat-value" id="stat-loan" style="color:var(--loan)">' + money(loan) + '</p></div>' +
    '<div><p class="stat-label"><span class="stat-dot" style="background:var(--ink-2)"></span>Own cash</p><p class="stat-value" id="stat-cash">' + money(cash) + '</p></div>' +
    '<div><p class="stat-label"><span class="stat-dot" style="background:var(--spend)"></span>Spent</p><p class="stat-value" id="stat-spent" style="color:var(--spend)">' + money(spent) + '</p></div>' +
    '<div><p class="stat-label"><span class="stat-dot" style="background:var(--accent)"></span>Pending</p><p class="stat-value" id="stat-pending">' + state.actions.filter(a => a.status !== 'done').length + '</p></div>' +
    '</div></div>';

  // Smart insights
  const now = Date.now();
  const d30 = now - 30 * 86400000;
  const d60 = now - 60 * 86400000;
  const spend30 = state.purchases.filter(p => {
    const t = p.date ? new Date(p.date).getTime() : 0;
    return t >= d30 && t <= now;
  }).reduce((s, p) => s + purchaseTotal(p), 0);
  const spendPrev30 = state.purchases.filter(p => {
    const t = p.date ? new Date(p.date).getTime() : 0;
    return t >= d60 && t < d30;
  }).reduce((s, p) => s + purchaseTotal(p), 0);
  const trendPct = spendPrev30 > 0 ? ((spend30 - spendPrev30) / spendPrev30) * 100 : 0;
  const topCat = Object.entries(state.purchases.reduce((acc, p) => {
    const c = (p.category || 'Uncategorized').trim();
    acc[c] = (acc[c] || 0) + purchaseTotal(p);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0];
  const topSeller = Object.entries(state.purchases.reduce((acc, p) => {
    const s = (p.seller || '').trim();
    if (!s) return acc;
    acc[s] = (acc[s] || 0) + purchaseTotal(p);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1])[0];
  html += '<div class="dash-section"><p class="dash-title">Smart insights</p><div class="insights-grid">' +
    '<div class="insight-card"><p class="k">30d spend</p><p class="v">' + money(spend30) + '</p></div>' +
    '<div class="insight-card"><p class="k">30d trend</p><p class="v ' + (trendPct > 0 ? 'bad' : 'good') + '">' + (spendPrev30 ? ((trendPct > 0 ? '+' : '') + trendPct.toFixed(1) + '%') : '—') + '</p></div>' +
    '<div class="insight-card"><p class="k">Top category</p><p class="v">' + esc(topCat ? topCat[0] : '—') + '</p><p class="s">' + money(topCat ? topCat[1] : 0) + '</p></div>' +
    '<div class="insight-card"><p class="k">Top seller</p><p class="v">' + esc(topSeller ? topSeller[0] : '—') + '</p><p class="s">' + money(topSeller ? topSeller[1] : 0) + '</p></div>' +
    '</div></div>';

  // Loan disbursement alerts
  html += '<div class="dash-section"><p class="dash-title">Fund health</p>';
  if (spent > 0) {
    const ratio = avail / spent;
    if (ratio > 0.3) html += '<div class="alert-card green"><p class="alert-title">🟢 Funds healthy</p><p class="alert-body">Available funds are above 30% of total spent.</p></div>';
    else if (ratio >= 0.1) html += '<div class="alert-card yellow"><p class="alert-title">🟡 Running low — request next tranche soon</p><p class="alert-body">Available funds are between 10–30% of total spent.</p></div>';
    else html += '<div class="alert-card red"><p class="alert-title">🔴 Funds critical — request disbursement NOW</p><p class="alert-body">Available funds are below 10% of total spent.</p></div>';
  } else {
    html += '<div class="alert-card green"><p class="alert-title">🟢 Funds healthy</p><p class="alert-body">No spending recorded yet.</p></div>';
  }
  // Runway projection
  const thirtyDaysAgo = now - 30 * 86400000;
  const recentSpend = state.purchases.filter(p => {
    const d = p.date ? new Date(p.date).getTime() : 0;
    return d >= thirtyDaysAgo && d <= now;
  }).reduce((s, p) => s + purchaseTotal(p), 0);
  const days30 = Math.min(30, state.purchases.length ? 30 : 0);
  const avgDaily = days30 > 0 ? recentSpend / 30 : 0;
  if (avgDaily > 0) {
    const runwayDays = Math.round(Math.max(0, avail) / avgDaily);
    const next30 = Math.round(avgDaily * 30);
    html += '<div class="alert-card green"><p class="alert-title">Projected runway</p>' +
      '<p class="alert-body">At current spending rate, funds last ~' + runwayDays + ' more days.</p></div>' +
      '<div class="alert-card green"><p class="alert-title">Next disbursement suggestion</p>' +
      '<p class="alert-body">Request ' + money(next30) + ' to cover next 30 days based on average spending.</p></div>';
  }
  html += '</div>';

  // Budget vs Actual bars
  if (state.budget.length) {
    html += '<div class="dash-section"><p class="dash-title">Budget vs Actual</p><table class="dash-table"><thead><tr>' +
      '<th>Category</th><th>Budgeted</th><th>Spent</th><th>Remaining</th><th></th></tr></thead><tbody>';
    state.budget.forEach(b => {
      const bud = +b.budgeted || 0, sp = spentForCat(b.category), rem = bud - sp;
      const w = bud > 0 ? Math.min(100, sp / bud * 100) : 0;
      const over = sp > bud;
      html += '<tr><td>' + esc(b.category) + '</td><td class="dash-stat">' + money(bud) + '</td>' +
        '<td class="dash-stat">' + money(sp) + '</td>' +
        '<td class="dash-stat" style="color:' + (rem < 0 ? 'var(--spend)' : 'var(--accent)') + '">' + money(rem) + '</td>' +
        '<td>' + (over ? '<span class="over-badge">OVER BUDGET</span>' : '') + '</td></tr>' +
        '<tr><td colspan="5" style="padding:0 6px 8px"><div class="bar"><span class="' + (over ? 'over' : '') + '" style="width:' + w + '%"></span></div></td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // Top sellers by spend
  const sellerTotals = {};
  state.purchases.forEach(p => {
    const s = (p.seller || '').trim();
    if (s) sellerTotals[s] = (sellerTotals[s] || 0) + purchaseTotal(p);
  });
  const topSellers = Object.entries(sellerTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topSellers.length) {
    html += '<div class="dash-section"><p class="dash-title">Top sellers by spend</p><table class="dash-table"><thead><tr><th>Seller</th><th>Total</th></tr></thead><tbody>';
    topSellers.forEach(([name, amt]) => {
      html += '<tr><td>' + esc(name) + '</td><td class="dash-stat">' + money(amt) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // Category breakdown
  const catTotals = {};
  state.purchases.forEach(p => {
    const c = (p.category || 'Uncategorized').trim();
    catTotals[c] = (catTotals[c] || 0) + purchaseTotal(p);
  });
  const catList = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  if (catList.length) {
    html += '<div class="dash-section"><p class="dash-title">Category breakdown</p><table class="dash-table"><thead><tr><th>Category</th><th>Spent</th></tr></thead><tbody>';
    catList.forEach(([cat, amt]) => {
      html += '<tr><td>' + esc(cat) + '</td><td class="dash-stat">' + money(amt) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  return html;
}

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
  const dayLabel = d => {
    if (!d) return '<span class="due-pill none">No due date</span>';
    const due = new Date(d + 'T00:00:00');
    if (!Number.isFinite(due.getTime())) return '<span class="due-pill none">No due date</span>';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
    if (diff > 0) return '<span class="due-pill soon">D-' + diff + ' · ' + esc(d) + '</span>';
    if (diff === 0) return '<span class="due-pill today">Due today · ' + esc(d) + '</span>';
    return '<span class="due-pill late">Exceeded by ' + Math.abs(diff) + 'd · ' + esc(d) + '</span>';
  };
  const items = sorted.map(a => '<div class="action-row">' +
    '<label class="action-check"><input type="checkbox" data-done="' + a.id + '"' + (a.status === 'done' ? ' checked' : '') + '><span></span></label>' +
    '<div class="action-main"><div class="entry-top"><div><p class="entry-name' + (a.status === 'done' ? ' done' : '') + '">' + esc(a.title) + '</p>' +
    (a.notes ? '<p class="entry-sub">' + esc(a.notes) + '</p>' : '') + '</div>' + chip(a.status) + '</div>' +
    '<div class="entry-meta"><span class="meta-item">' + dayLabel(a.due) + '</span></div>' +
    '<div class="entry-actions"><button class="icon-btn" data-edit="actions" data-id="' + a.id + '">Edit</button>' +
    '<button class="icon-btn danger" data-del="actions" data-id="' + a.id + '">Delete</button></div></div></div>').join('');
  return head('Action checklist', 'Checklist sorted by due date with D-day and overdue indicators.', 'actions') +
    (state.actions.length ? '<div class="entry-list">' + items + '</div>' : empty('No actions yet', 'Add things like "Get quote for tiles".'));
}
function renderSellers() {
  const fromLines = [];
  state.purchases.forEach(p => {
    const seller = (p.seller || '').trim();
    const cat = (p.category || '').trim();
    if (!Array.isArray(p.lines)) return;
    p.lines.forEach(l => {
      const item = String((l && l.item) || '').trim();
      if (!item) return;
      const amount = Number(l.amount) || 0;
      const qty = Number(l.qty) || 0;
      const unit = qty > 0 ? amount / qty : (Number(l.rate) || 0);
      fromLines.push({item, seller, category: cat || 'Uncategorized', amount, unit, date: p.date || ''});
    });
  });
  const byItem = {};
  fromLines.forEach(r => {
    const key = r.item.toLowerCase();
    if (!byItem[key]) byItem[key] = {item: r.item, category: r.category, rows: []};
    byItem[key].rows.push(r);
  });
  const intelligence = Object.values(byItem).map(x => {
    const priced = x.rows.filter(r => r.unit > 0);
    if (!priced.length) return null;
    priced.sort((a, b) => a.unit - b.unit);
    const best = priced[0], worst = priced[priced.length - 1];
    const avg = priced.reduce((s, r) => s + r.unit, 0) / priced.length;
    return {item: x.item, category: x.category, best, worst, avg, samples: priced.length};
  }).filter(Boolean).sort((a, b) => (a.best.unit - b.best.unit)).slice(0, 80);

  const quoteRows = [];
  state.sellers.forEach(s => {
    const lines = Array.isArray(s.quoteLines) ? s.quoteLines : [];
    lines.forEach(l => quoteRows.push({
      sellerId: s.id,
      seller: s.name || '',
      item: l.item || '',
      qty: Number(l.qty) || 0,
      rate: Number(l.rate) || 0,
      amount: Number(l.amount) || 0,
      status: s.status || ''
    }));
  });
  const q = sellerItemSearch.trim().toLowerCase();
  const filteredQuotes = q ? quoteRows.filter(r =>
    String(r.item || '').toLowerCase().includes(q) ||
    String(r.seller || '').toLowerCase().includes(q) ||
    String(r.status || '').toLowerCase().includes(q)
  ) : quoteRows;

  const items = state.sellers.map(s => '<div class="entry"><div class="entry-top"><div><p class="entry-name">' + esc(s.name) + '</p>' +
    (s.contact ? '<p class="entry-sub">' + esc(s.contact) + '</p>' : '') + '</div>' + chip(s.status) + '</div>' +
    (Array.isArray(s.photos) && s.photos.length ? ('<div class="photo-list" style="margin-top:8px">' + s.photos.slice(0, 6).map((ph, i) => '<img src="' + esc(ph.thumb || ph.url || '') + '" data-seller-lightbox="' + s.id + ':' + i + '" alt="Seller photo">').join('') + '</div>') : '') +
    (Array.isArray(s.photoLinks) && s.photoLinks.length ? ('<div class="entry-meta">' + s.photoLinks.slice(0, 3).map((ln, i) => '<a href="' + esc(ln.webViewLink || ln.url || '#') + '" target="_blank" rel="noopener">Photo ' + (i + 1) + '</a>').join(' ') + '</div>') : '') +
    '<div class="entry-meta">' + (s.item ? '<span class="meta-item">' + esc(s.item) + '</span>' : '') +
    ((s.price !== '' && s.price != null) ? '<span class="meta-item">Quoted <strong>' + money(s.price) + '</strong></span>' : '') +
    (s.notes ? '<span class="meta-item">' + esc(s.notes) + '</span>' : '') + '</div>' +
    '<div class="entry-actions"><button class="icon-btn" data-edit="sellers" data-id="' + s.id + '">Edit</button>' +
    '<button class="icon-btn danger" data-del="sellers" data-id="' + s.id + '">Delete</button></div></div>').join('');
  const bestTable = intelligence.length
    ? ('<div class="dash-section"><p class="dash-title">Best Price Intelligence (from your receipts/screenshots)</p>' +
      '<div class="purchase-table-wrap"><table class="purchase-table"><thead><tr><th>Item</th><th>Category</th><th>Best seller</th><th>Best unit</th><th>Avg unit</th><th>Worst unit</th><th>Samples</th></tr></thead><tbody>' +
      intelligence.map(r => '<tr><td>' + esc(r.item) + '</td><td>' + esc(r.category) + '</td><td>' + esc(r.best.seller || 'Unknown') + '</td><td>' + money(r.best.unit) + '</td><td>' + money(r.avg) + '</td><td>' + money(r.worst.unit) + '</td><td>' + r.samples + '</td></tr>').join('') +
      '</tbody></table></div></div>')
    : '<div class="set-note">No comparable line-item prices yet. Add more screenshots/receipts with qty and amount to unlock best-price ranking.</div>';
  return head('Seller shortlist', 'Compare suppliers and contractor quotes. Auto-rank best item prices from your purchase screenshots.', 'sellers') +
    '<div class="purchase-toolbar"><input class="seller-search-field seller-item-search" placeholder="Search seller items fast…" value="' + esc(sellerItemSearch) + '"></div>' +
    '<div class="purchase-table-wrap"><table class="purchase-table"><thead><tr><th>Item</th><th>Seller</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Status</th></tr></thead><tbody>' +
    (filteredQuotes.length ? filteredQuotes.map(r => '<tr><td>' + esc(r.item) + '</td><td>' + esc(r.seller) + '</td><td>' + esc(r.qty || '') + '</td><td>' + money(r.rate || 0) + '</td><td>' + money(r.amount || 0) + '</td><td>' + chip(r.status) + '</td></tr>').join('') : '<tr><td colspan="6" style="text-align:center;padding:18px;color:var(--ink-2)">No extracted seller items yet. Upload seller screenshots/photos to build this table.</td></tr>') +
    '</tbody></table></div>' +
    bestTable +
    (state.sellers.length ? '<div class="entry-list">' + items + '</div>' : empty('No sellers shortlisted yet', 'Add suppliers with their quoted price and status.'));
}
let purchaseSort = {col: 'date', asc: false};
let purchaseSearch = '';
let purchaseCatFilter = '';
let purchaseExpandedId = null;

function renderPurchases() {
  if (!state.purchases.length) {
    return head('Purchases &amp; receipts', 'Camera or Gallery scans with AI. Correct the fields, then Save. The original photo is kept.', 'purchases') +
      empty('No purchases logged yet', 'Take a photo or pick from the gallery. AI fills the table; Save stays at the bottom.');
  }

  const cats = [...new Set(state.purchases.map(p => p.category).filter(Boolean))].sort();
  const catOpts = '<option value="">All categories</option>' + cats.map(c => '<option value="' + esc(c) + '"' + (purchaseCatFilter === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('');

  const q = purchaseSearch.toLowerCase();
  let filtered = state.purchases.filter(p => {
    if (purchaseCatFilter && (p.category || '') !== purchaseCatFilter) return false;
    if (q && !(p.item || '').toLowerCase().includes(q) && !(p.seller || '').toLowerCase().includes(q) &&
        !(p.category || '').toLowerCase().includes(q) && !(p.receipt || '').toLowerCase().includes(q)) return false;
    return true;
  });

  const sc = purchaseSort.col, dir = purchaseSort.asc ? 1 : -1;
  filtered.sort((a, b) => {
    let va = a[sc] || '', vb = b[sc] || '';
    if (sc === 'price') return (((+va) || 0) - ((+vb) || 0)) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });

  const arrow = col => '<span class="sort-arrow">' + (purchaseSort.col === col ? (purchaseSort.asc ? '▲' : '▼') : '') + '</span>';
  const thCls = col => purchaseSort.col === col ? ' class="sorted"' : '';
  const cols = [['date','Date'],['item','Item'],['seller','Seller'],['category','Category'],['price','Total'],['receipt','Receipt #']];

  let rows = '';
  filtered.forEach(p => {
    const lineSum = Array.isArray(p.lines) && p.lines.length
      ? p.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) : 0;
    const displayPrice = lineSum || +p.price || 0;
    rows += '<tr class="clickable" data-row-id="' + p.id + '">' +
      '<td>' + esc(p.date || '') + '</td>' +
      '<td>' + (p.thumb ? '<img src="' + p.thumb + '" class="thumb-sm" data-lightbox="' + p.id + '" alt="">' : '') + esc(p.item || '') + '</td>' +
      '<td>' + esc(p.seller || '') + '</td>' +
      '<td>' + esc(p.category || '') + '</td>' +
      '<td style="font-family:ui-monospace,\'SF Mono\',Menlo,monospace;font-weight:600">' + money(displayPrice) + '</td>' +
      '<td>' + esc(p.receipt || '') + '</td>' +
      '<td><div class="row-actions">' +
      '<button class="icon-btn" data-edit="purchases" data-id="' + p.id + '">Edit</button>' +
      '<button class="icon-btn danger" data-del="purchases" data-id="' + p.id + '">Delete</button>' +
      '</div></td></tr>';

    if (purchaseExpandedId === p.id) {
      rows += '<tr class="purchase-detail"><td colspan="7">' + renderPurchaseDetail(p) + '</td></tr>';
    }
  });

  return head('Purchases &amp; receipts', 'Camera or Gallery scans with AI. Correct the fields, then Save. The original photo is kept.', 'purchases') +
    '<div class="purchase-toolbar">' +
    '<input class="purchase-search" placeholder="Search purchases\u2026" value="' + esc(purchaseSearch) + '">' +
    '<select class="purchase-cat-filter">' + catOpts + '</select></div>' +
    '<div class="purchase-table-wrap"><table class="purchase-table"><thead><tr>' +
    cols.map(([k, l]) => '<th data-sort="' + k + '"' + thCls(k) + '>' + l + arrow(k) + '</th>').join('') +
    '<th>Actions</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--ink-2)">No matches</td></tr>') + '</tbody></table></div>';
}

function renderPurchaseDetail(p) {
  let html = '';
  if (p.thumb) html += '<img src="' + p.thumb + '" class="detail-photo" data-lightbox="' + p.id + '" alt="Receipt">';
  html += '<dl class="detail-grid">';
  html += '<dt>Seller</dt><dd>' + esc(p.seller || '—') + '</dd>';
  html += '<dt>Date</dt><dd>' + esc(p.date || '—') + '</dd>';
  html += '<dt>Category</dt><dd>' + esc(p.category || '—') + '</dd>';
  if (p.receipt) html += '<dt>Receipt #</dt><dd>' + esc(p.receipt) + '</dd>';
  if (p.driveLink) html += '<dt>Drive</dt><dd><a href="' + esc(p.driveLink) + '" target="_blank" rel="noopener">' + esc(p.driveFolder || 'Open in Drive') + '</a></dd>';
  const lineSum = Array.isArray(p.lines) && p.lines.length
    ? p.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) : 0;
  const displayTotal = lineSum || +p.price || 0;
  html += '<dt>Total</dt><dd style="font-weight:600">' + money(displayTotal) + '</dd>';
  html += '</dl>';
  if (Array.isArray(p.lines) && p.lines.length) {
    html += '<table class="detail-lines"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>';
    p.lines.forEach(l => {
      html += '<tr><td>' + esc(l.item || '') + '</td><td>' + esc(l.qty || '') + '</td><td>' + esc(l.rate || '') + '</td><td>' + money(l.amount) + '</td></tr>';
    });
    html += '<tr style="font-weight:600;border-top:2px solid var(--line)"><td colspan="3" style="text-align:right;padding:8px 6px;color:var(--ink-2)">Total</td><td style="padding:8px 6px">' + money(displayTotal) + '</td></tr>';
    html += '</tbody></table>';
  }
  return html;
}

export function render() {
  computeSummary();
  const renderer = {dashboard: renderDashboard, funds: renderFunds, budget: renderBudget, actions: renderActions, sellers: renderSellers, purchases: renderPurchases}[session.activeTab];
  $('panel-root').innerHTML = renderer ? renderer() : renderDashboard();
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
    if (it) {
      if (b.type === 'checkbox') it.status = b.checked ? 'done' : 'pending';
      else it.status = 'done';
      await persist('actions');
      render();
      if (settings.driveToken) scheduleCsvSync();
    }
  });
  root.querySelectorAll('[data-lightbox]').forEach(im => im.onclick = e => {
    e.stopPropagation();
    const r = state.purchases.find(x => x.id === im.dataset.lightbox);
    if (r && r.driveLink) { window.open(r.driveLink, '_blank', 'noopener'); return; }
    if (r && r.thumb) { $('lightbox-img').src = r.thumb; $('lightbox').classList.add('show'); }
  });
  root.querySelectorAll('[data-seller-lightbox]').forEach(im => im.onclick = e => {
    e.stopPropagation();
    const [sid, idx] = String(im.dataset.sellerLightbox || '').split(':');
    const s = state.sellers.find(x => x.id === sid);
    if (!s || !Array.isArray(s.photos)) return;
    const ph = s.photos[Number(idx) || 0];
    if (!ph) return;
    $('lightbox-img').src = ph.url || ph.thumb || '';
    $('lightbox').classList.add('show');
  });
  const sellerSearchEl = root.querySelector('.seller-item-search');
  if (sellerSearchEl) {
    sellerSearchEl.oninput = e => { sellerItemSearch = e.target.value; render(); };
  }
  const searchEl = root.querySelector('.purchase-search');
  if (searchEl) {
    searchEl.oninput = e => { purchaseSearch = e.target.value; render(); };
    if (document.activeElement === null || purchaseSearch) {
      const pos = searchEl.value.length;
      searchEl.focus();
      searchEl.setSelectionRange(pos, pos);
    }
  }
  const catEl = root.querySelector('.purchase-cat-filter');
  if (catEl) catEl.onchange = e => { purchaseCatFilter = e.target.value; render(); };
  root.querySelectorAll('.purchase-table th[data-sort]').forEach(th => th.onclick = () => {
    const col = th.dataset.sort;
    if (purchaseSort.col === col) purchaseSort.asc = !purchaseSort.asc;
    else { purchaseSort.col = col; purchaseSort.asc = true; }
    render();
  });
  root.querySelectorAll('tr.clickable[data-row-id]').forEach(tr => tr.onclick = e => {
    if (e.target.closest('[data-edit],[data-del]')) return;
    const id = tr.dataset.rowId;
    purchaseExpandedId = purchaseExpandedId === id ? null : id;
    render();
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
    p = p || {name: '', contact: '', item: '', price: '', status: 'shortlisted', notes: '', photos: [], photoLinks: []};
    const curPhotos = sellerPendingPhotos.length ? sellerPendingPhotos : (Array.isArray(p.photos) ? p.photos : []);
    const curLines = sellerPendingLines.length ? sellerPendingLines : (Array.isArray(p.quoteLines) ? p.quoteLines : []);
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
      '<div class="field wide"><label>Photos (storefront / quote screenshot)</label>' +
      '<div class="photo-actions"><label class="photo-btn">Add photos<input type="file" accept="image/*" multiple id="m-seller-photo" style="display:none"></label></div>' +
      '<div class="photo-list" id="m-seller-photo-list">' + curPhotos.map((ph, i) => '<img src="' + esc(ph.thumb || ph.url || '') + '" data-seller-modal-photo="' + i + '" alt="Seller photo ' + (i + 1) + '">').join('') + '</div>' +
      '<button type="button" class="photo-remove" id="m-seller-photo-remove" style="' + (curPhotos.length ? '' : 'display:none') + '">Remove all seller photos</button></div>' +
      '<div class="field wide"><label>Extracted line items</label><p class="field-hint" id="m-seller-ocr-status">' + (curLines.length ? ('Loaded ' + curLines.length + ' extracted lines.') : 'Add seller screenshots/photos to auto-extract items.') + '</p><div id="m-seller-lines">' + sellerLinesTableHtml(curLines) + '</div></div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="Optional"></div></div>';
  }
  if (kind === 'purchases') {
    p = p || {item: '', category: '', seller: '', price: '', date: todayStr(), receipt: '', thumb: null, lines: []};
    const pendingPhotos = (session.pending && Array.isArray(session.pending.photos)) ? session.pending.photos : [];
    const cur = (pendingPhotos[0] && (pendingPhotos[0].thumbDataUrl || pendingPhotos[0].previewUrl)) || p.thumb;
    const hasKey = !!settings.apiKey;
    const lines = parsePurchaseLines(p);
    return '<div class="photo-field" style="margin-bottom:14px">' +
      '<div class="photo-actions">' +
      '<label class="photo-btn"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>Camera' +
      '<input type="file" accept="image/*" capture="environment" id="m-photo-cam" style="display:none"></label>' +
      '<label class="photo-btn"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>Gallery' +
      '<input type="file" accept="image/*" multiple id="m-photo" style="display:none"></label></div>' +
      '<p class="field-hint">For multi-page receipts, add all photos first. AI reads every page into one table.</p>' +
      (hasKey ? '' : '<div class="inline-ai" id="inline-ai"><p>Paste your AI key once so scan can run. It is saved to your Drive profile.</p>' +
        '<div class="form-grid">' +
        '<div class="field"><label>Provider</label><select id="m-ai-provider">' + providerOptionsHtml() + '</select></div>' +
        '<div class="field"><label>API key</label><input id="m-ai-key" type="password" placeholder="sk-… or your provider key" autocomplete="off"></div></div>' +
        '<div id="m-ai-custom" style="display:none;margin-top:10px">' +
        '<div class="field wide"><label class="req">API base URL</label><input id="m-ai-base" value="' + esc(settings.apiBase) + '" placeholder="https://api.example.com/v1" autocomplete="off"></div></div>' +
        modelPickerHtml('m-ai') + '</div>') +
      '<button type="button" class="ocr-btn" id="m-ocr" style="margin-top:10px"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg>' + (hasKey ? 'Re-scan with AI' : 'Scan receipt') + '</button>' +
      '<div class="ocr-status" id="m-ocr-status"></div>' +
      '<div class="photo-preview ' + (cur ? 'show' : '') + '" id="m-photo-preview"><div class="photo-list" id="m-photo-list">' + (cur ? ('<img src="' + cur + '" alt="Receipt page 1">') : '') + '</div>' +
      '<div class="photo-preview-meta"><p class="field-hint" id="m-photo-meta">' + (cur ? 'Photo attached. Tap it to view larger.' : '') + '</p>' +
      '<button type="button" class="photo-remove" id="m-photo-remove">Remove photos</button></div></div></div>' +
      '<div class="receipt-meta">' +
      '<div class="field"><label>Seller</label><input id="m-seller" value="' + esc(p.seller) + '" placeholder="Shop / company" autocomplete="off"></div>' +
      '<div class="field"><label>Date</label><input type="date" id="m-date" value="' + esc(p.date || todayStr()) + '"></div>' +
      '<div class="field"><label>Category</label><input list="category-options" id="m-category" value="' + esc(p.category) + '" placeholder="Foundation…"></div>' +
      '<div class="field"><label>Receipt no.</label><input id="m-receipt" value="' + esc(p.receipt) + '" placeholder="Optional"></div></div>' +
      '<p class="field-hint receipt-table-label">Line items from the bill — AI fills this table; tap a cell to correct.</p>' +
      purchaseLinesHtml(lines) +
      '<div class="receipt-total-row">' +
      '<div class="field"><label class="req">Total (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-price" value="' + esc(p.price) + '" placeholder="Grand total"></div>' +
      '<div class="field"><label class="req">Summary</label><input id="m-item" value="' + esc(p.item) + '" placeholder="Short label for the list"></div></div>';
  }
  return '';
}

export function openModal(kind, rec) {
  session.editKind = kind;
  session.editing = rec || null;
  session.photoCleared = false;
  clearPendingPhoto();
  sellerPendingPhotos = [];
  sellerPendingLines = (kind === 'sellers' && rec && Array.isArray(rec.quoteLines)) ? rec.quoteLines.slice() : [];
  const title = (rec ? TITLES[kind][1] : TITLES[kind][0]);
  const sub = {
    funds: 'How much came in, and from where.',
    budget: 'A category and the amount you planned for it.',
    actions: 'One thing still to do. Due date is optional.',
    sellers: 'A supplier and their quote, if you have it.',
    purchases: 'Take or upload a receipt. AI fills the line-item table — you can correct it. Save stays at the bottom.'
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
  sellerPendingPhotos.forEach(ph => { if (ph && ph.url && ph.url.startsWith('blob:')) try { URL.revokeObjectURL(ph.url); } catch (e) {} });
  sellerPendingPhotos = [];
  sellerPendingLines = [];
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
    const fs = [...(e.target.files || [])];
    if (!fs.length) return;
    for (const f of fs) await handlePhoto(f, true);
    await maybeScanAfterPhoto();
    e.target.value = '';
  };
  const pin = $('m-photo'); if (pin) pin.addEventListener('change', onFile);
  const cam = $('m-photo-cam'); if (cam) cam.addEventListener('change', onFile);
  const prm = $('m-photo-remove'); if (prm) prm.onclick = removePendingPhoto;
  const ocr = $('m-ocr'); if (ocr) ocr.onclick = startReceiptScan;
  const imgs = $('m-photo-list');
  if (imgs) imgs.querySelectorAll('img').forEach((img, i) => { img.onclick = () => openPhotoLightbox(i); });
  $('modal').addEventListener('paste', async e => {
    if (session.editKind !== 'purchases') return;
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const files = items.filter(it => it.type && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await handlePhoto(f, true);
    await maybeScanAfterPhoto();
  });
  const sellerIn = $('m-seller-photo');
  if (sellerIn) sellerIn.addEventListener('change', async e => {
    const fs = [...(e.target.files || [])];
    if (!fs.length) return;
    for (const f of fs) {
      const thumb = await compressImage(f, 360, 0.6);
      const ocrDataUrl = await compressImage(f, 2000, 0.85).catch(() => thumb);
      let url = '';
      try { url = URL.createObjectURL(f); } catch (err) {}
      sellerPendingPhotos.push({file: f, ext: extFromFile(f), thumb: thumb || url, url: url || thumb, ocrDataUrl: ocrDataUrl || thumb || url});
    }
    const list = $('m-seller-photo-list');
    if (list) list.innerHTML = sellerPendingPhotos.map((ph, i) => '<img src="' + esc(ph.thumb || ph.url || '') + '" data-seller-modal-photo="' + i + '" alt="Seller photo ' + (i + 1) + '">').join('');
    const rm = $('m-seller-photo-remove');
    if (rm) rm.style.display = sellerPendingPhotos.length ? '' : 'none';
    if (settings.apiKey) await extractSellerLinesFromPending(false);
    e.target.value = '';
  });
  const rmSeller = $('m-seller-photo-remove');
  if (rmSeller) rmSeller.onclick = () => {
    sellerPendingPhotos.forEach(ph => { if (ph && ph.url && ph.url.startsWith('blob:')) try { URL.revokeObjectURL(ph.url); } catch (e) {} });
    sellerPendingPhotos = [];
    const list = $('m-seller-photo-list');
    if (list) list.innerHTML = '';
    rmSeller.style.display = 'none';
  };
  wireModelPicker('m-ai', 'm-ai-custom');
  bindLineTable();
}

function showErr(msg) {
  const e = $('modal-error');
  e.textContent = msg;
  e.classList.add('show');
}

async function saveModal() {
  const k = session.editKind, val = id => { const el = $(id); return el ? el.value : ''; };
  if (!k || !state[k]) return showErr('Could not save: invalid form state. Close and open again.');
  let obj;
  try {
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
    obj.quoteLines = sellerPendingLines.length ? sellerPendingLines.slice() : (session.editing && Array.isArray(session.editing.quoteLines) ? session.editing.quoteLines.slice() : []);
    if (sellerPendingPhotos.length) {
      obj.photos = sellerPendingPhotos.map(ph => ({thumb: ph.thumb, url: ph.url}));
      if (settings.driveToken) {
        const links = [];
        for (const ph of sellerPendingPhotos) {
          try {
            const up = await uploadSellerOriginalToDrive(ph.file || ph.url, {
              name: obj.name, item: obj.item, date: todayStr(), ext: ph.ext
            });
            if (up) links.push({id: up.id, webViewLink: up.webViewLink, folderPath: up.folderPath || ''});
          } catch (e) {}
        }
        obj.photoLinks = links;
      } else {
        obj.photoLinks = [];
      }
    } else if (session.editing && Array.isArray(session.editing.photos)) {
      obj.photos = session.editing.photos.slice();
      obj.photoLinks = Array.isArray(session.editing.photoLinks) ? session.editing.photoLinks.slice() : [];
    }
  } else if (k === 'purchases') {
    const form = readPurchaseForm();
    if (!form.item) return showErr('Enter a summary or at least one line item.');
    if (form.price === '' || !finiteNum(form.price) || +form.price < 0) return showErr('Enter a valid total amount.');
    const cat = form.category || 'Uncategorized';
    const pending = session.pending;
    const pendingPhotos = pending && Array.isArray(pending.photos) ? pending.photos : [];
    const firstPending = pendingPhotos[0] || null;
    const thumb = session.photoCleared ? null : ((firstPending && firstPending.thumbDataUrl) || (session.editing ? session.editing.thumb : null) || null);
    obj = {
      item: form.item,
      category: cat === 'Uncategorized' && !($('m-category') && $('m-category').value.trim()) ? '' : cat,
      seller: form.seller,
      price: +form.price,
      date: form.date || todayStr(),
      receipt: form.receipt,
      lines: form.lines,
      thumb
    };
    if (obj.receipt) {
      const rn = obj.receipt.trim().toLowerCase();
      const editId = session.editing ? session.editing.id : null;
      const dup = state.purchases.find(x => x.id !== editId && (x.receipt || '').trim().toLowerCase() === rn && rn);
      if (dup && !confirm('Receipt #' + obj.receipt + ' already exists on ' + (dup.date || '?') + ' from ' + (dup.seller || '?') + '. Save anyway?')) return;
    }
    if (pendingPhotos.length && settings.driveToken) {
      try {
        const oldIds = [];
        if (session.editing && Array.isArray(session.editing.driveFileIds)) oldIds.push(...session.editing.driveFileIds.filter(Boolean));
        else if (session.editing && session.editing.driveFileId) oldIds.push(session.editing.driveFileId);
        for (const id of oldIds) await deleteDriveFile(id);
        const uploaded = [];
        for (const ph of pendingPhotos) {
          const link = await uploadOriginalToDrive(ph.originalFile, {
            item: obj.item, category: obj.category, seller: obj.seller, date: obj.date, receipt: obj.receipt, ext: ph.ext
          });
          if (link) uploaded.push(link);
        }
        if (uploaded.length) {
          obj.driveLink = uploaded[0].webViewLink;
          obj.driveFileId = uploaded[0].id;
          obj.driveFolder = uploaded[0].folderPath || '';
          obj.driveFileIds = uploaded.map(x => x.id);
          obj.driveFiles = uploaded.map((x, i) => ({id: x.id, webViewLink: x.webViewLink, folderPath: x.folderPath || '', page: i + 1}));
        }
      } catch (e) {
        return showErr('Could not upload receipt photos to Drive. Enable Drive API if needed, then tap Save again. The photos are still attached.');
      }
    } else if (pendingPhotos.length && !settings.driveToken) {
      toast('Saved on this device. Sign in to keep the original photos in Drive.');
    } else if (session.photoCleared) {
      obj.driveLink = null; obj.driveFileId = null; obj.driveFolder = null; obj.driveFileIds = []; obj.driveFiles = [];
    } else if (session.editing && session.editing.driveLink) {
      obj.driveLink = session.editing.driveLink;
      obj.driveFileId = session.editing.driveFileId;
      obj.driveFolder = session.editing.driveFolder;
      obj.driveFileIds = Array.isArray(session.editing.driveFileIds) ? session.editing.driveFileIds.slice() : (session.editing.driveFileId ? [session.editing.driveFileId] : []);
      obj.driveFiles = Array.isArray(session.editing.driveFiles) ? session.editing.driveFiles.slice() : [];
    }
  }
  if (session.editing) Object.assign(session.editing, obj);
  else { obj.id = uid(); state[k].push(obj); }
  await persist(k);
  closeModal();
  sellerPendingPhotos.forEach(ph => { if (ph && ph.url && ph.url.startsWith('blob:')) try { URL.revokeObjectURL(ph.url); } catch (e) {} });
  sellerPendingPhotos = [];
  render();
  if (settings.driveToken) scheduleCsvSync();
  } catch (e) {
    console.error(e);
    showErr(e && e.message ? e.message : 'Could not save. Please try again.');
  }
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
    '<div class="set-section"><h3>AI Chat assistant</h3><p class="hint">Choose a model for the chat bot. Can be different from the receipt scanner (e.g. a cheaper/faster model).</p>' +
    '<div class="field" style="margin-bottom:10px"><label>Chat model</label><select id="set-chat-model"><option value="">Same as scan model</option></select></div></div>' +
    '<div class="set-section"><h3>Manual backup (CSV)</h3><p class="hint">Export a local copy, or import to replace current data.</p>' +
    '<div class="set-row"><button class="set-btn" id="csv-export">Export CSV</button>' +
    '<button class="set-btn" id="csv-import">Import CSV</button>' +
    '<input type="file" accept=".csv,text/csv" id="csv-file" style="display:none"></div></div></div>' +
    '<div class="modal-actions"><button class="btn-primary" id="set-save">Save settings</button></div>';
  $('set-close').onclick = () => $('settings-overlay').classList.remove('show');
  wireModelPicker('set', 'set-custom');
  const chatModelSel = $('set-chat-model');
  if (chatModelSel && Array.isArray(settings.models)) {
    settings.models.forEach(id => {
      const o = document.createElement('option');
      o.value = id; o.textContent = id;
      if (id === settings.chatModel) o.selected = true;
      chatModelSel.appendChild(o);
    });
    if (settings.chatModel && !settings.models.includes(settings.chatModel)) {
      const o = document.createElement('option');
      o.value = settings.chatModel; o.textContent = settings.chatModel; o.selected = true;
      chatModelSel.appendChild(o);
    }
  }
  $('set-save').onclick = async () => {
    settings.provider = $('set-provider').value;
    settings.apiKey = $('set-key').value.trim();
    settings.model = readModelValue('set');
    const baseEl = $('set-base'); if (baseEl) settings.apiBase = baseEl.value.trim();
    const modelSel = $('set-model');
    if (modelSel && Array.isArray(modelSel._allModels) && modelSel._allModels.length) settings.models = modelSel._allModels.slice(0, 400);
    const chatMSel = $('set-chat-model'); if (chatMSel) settings.chatModel = chatMSel.value;
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
    localStorage.setItem('sl.tab', session.activeTab);
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === session.activeTab));
    render();
  });
  $('overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  $('lightbox-close').onclick = () => $('lightbox').classList.remove('show');
  $('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('lightbox').classList.remove('show'); });
  $('open-settings').onclick = () => { renderSettings(); $('settings-overlay').classList.add('show'); };
  $('settings-overlay').addEventListener('click', e => { if (e.target.id === 'settings-overlay') $('settings-overlay').classList.remove('show'); });
  $('sync-pill').addEventListener('click', () => {
    if (settings.driveToken && session.syncStatus !== 'error') return;
    startGoogleLogin(false);
  });
}

hub.render = render;
hub.updateSyncPill = updateSyncPill;
