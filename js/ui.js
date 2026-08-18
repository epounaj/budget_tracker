import {TITLES, CHIP} from './config.js?v=20260818v';
import {state, settings, session, persist, saveSettings} from './store.js?v=20260818v';
import {$, esc, money, moneyDec, fmtNum, todayStr, uid, finiteNum, toast, normalizeCategory, lineAmount, sumLines, purchaseCategories, summarizePurchase, guessCategoryFromItem} from './util.js?v=20260818v';
import {hub} from './hub.js?v=20260818v';
import {providerOptionsHtml, modelPickerHtml, wireModelPicker, readModelValue, chatCompletionsUrl} from './ai.js?v=20260818v';
import {maybeScanAfterPhoto, startReceiptScan, purchaseLinesHtml, bindLineTable, readPurchaseForm, readLinesFromTable, readSellerQuoteGroups, sellerNameKey, categoryPillsHtml, prefillEmptyLineCategories, fillMissingWithAi} from './receipts.js?v=20260818v';
import {bindPhotoPreview, bindLightboxShell, bindAlbumControls, photoFieldHtml, existingFormPhotos, pendingPhotos, persistablePhoto, clearPendingPhoto} from './photos.js?v=20260818v';
import {driveApiEnableUrl, ensureDriveFolder, saveProfileToDrive, deleteDriveFile, uploadOriginalToDrive, uploadSellerOriginalToDrive, scheduleCsvSync, syncCsvToDrive, updateSyncPill, pullCsvFromDrive} from './drive.js?v=20260818v';
import {downloadCSV, importCSVFile} from './csv.js?v=20260818v';
import {googleLogout, startGoogleLogin} from './auth.js?v=20260818v';

let sellerItemSearch = '';
let saveBusy = false;

const ICO = {
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4h8v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>'
};
function actBtns(kind, id) {
  return '<div class="row-actions">' +
    '<button type="button" class="icon-btn icon-only" data-edit="' + kind + '" data-id="' + id + '" title="Edit" aria-label="Edit">' + ICO.edit + '</button>' +
    '<button type="button" class="icon-btn icon-only danger" data-del="' + kind + '" data-id="' + id + '" title="Delete" aria-label="Delete">' + ICO.trash + '</button></div>';
}
function catChips(p) {
  const cats = purchaseCategories(p);
  if (!cats.length) return '<span class="muted">—</span>';
  return cats.map(c => '<span class="chip cat">' + esc(c) + '</span>').join('');
}
function setSaveBusy(on) {
  saveBusy = !!on;
  const btn = $('modal-save');
  if (!btn) return;
  btn.disabled = !!on;
  btn.textContent = on ? 'Saving…' : (session.editing ? 'Save changes' : 'Save');
}

function chip(status) {
  const map = CHIP || {};
  const meta = map[status] || [String(status || 'pending'), String(status || 'Pending')];
  return '<span class="chip ' + esc(meta[0]) + '">' + esc(meta[1]) + '</span>';
}

function parsePurchaseLines(p) {
  if (!p) return [{item: '', qty: '', rate: '', amount: '', category: ''}];
  let lines = [];
  if (Array.isArray(p.lines) && p.lines.length) lines = p.lines;
  else if (p.lines && typeof p.lines === 'string') {
    try {
      const arr = JSON.parse(p.lines);
      if (Array.isArray(arr) && arr.length) lines = arr;
    } catch (e) {}
  } else if (p.item || p.price) return [{item: p.item || '', qty: '', rate: '', amount: p.price || '', category: ''}];
  if (!lines.length) return [{item: '', qty: '', rate: '', amount: '', category: ''}];
  const mapped = lines.map(l => {
    const computed = lineAmount(l);
    return {item: l.item || '', qty: l.qty || '', rate: l.rate || '', amount: computed || l.amount || '', category: normalizeCategory(l.category)};
  });
  const cats = purchaseCategories(p);
  const siblingItems = mapped.map(l => l.item);
  mapped.forEach(l => {
    if (l.category) return;
    if (cats.length === 1) l.category = cats[0];
    else l.category = guessCategoryFromItem(l.item, {allowed: cats, siblingItems});
  });
  return mapped;
}

function loanReceived() { return state.funds.filter(f => f.type === 'loan').reduce((s, f) => s + (+f.amount || 0), 0); }
function ownCash() { return state.funds.filter(f => f.type === 'cash').reduce((s, f) => s + (+f.amount || 0), 0); }
function purchaseTotal(p) {
  const ls = sumLines(p && p.lines);
  return ls || +p.price || 0;
}
function totalSpent() { return state.purchases.reduce((s, p) => s + purchaseTotal(p), 0); }
function spentForCat(c) {
  const key = String(c || '').toLowerCase();
  return state.purchases.reduce((s, p) => {
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const tagged = lines.filter(l => normalizeCategory(l.category));
    if (tagged.length) return s + tagged.filter(l => normalizeCategory(l.category).toLowerCase() === key).reduce((a, l) => a + lineAmount(l), 0);
    const cats = purchaseCategories(p);
    if (!cats.length) return s;
    if (cats.length === 1 && cats[0].toLowerCase() === key) return s + purchaseTotal(p);
    if (cats.some(x => x.toLowerCase() === key)) return s + purchaseTotal(p) / cats.length;
    return s;
  }, 0);
}

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
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--loan)"></span>Loan received</p><p class="stat-value" id="stat-loan" style="color:var(--loan)">' + money(loan) + '</p></div>' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--ink-2)"></span>Own cash</p><p class="stat-value" id="stat-cash">' + money(cash) + '</p></div>' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--spend)"></span>Spent</p><p class="stat-value" id="stat-spent" style="color:var(--spend)">' + money(spent) + '</p></div>' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--accent)"></span>Pending</p><p class="stat-value" id="stat-pending">' + state.actions.filter(a => a.status !== 'done').length + '</p></div>' +
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
    if (ratio > 0.3) html += '<div class="alert-card green"><p class="alert-title">Funds healthy</p><p class="alert-body">Available funds are above 30% of total spent.</p></div>';
    else if (ratio >= 0.1) html += '<div class="alert-card yellow"><p class="alert-title">Running low — request next tranche soon</p><p class="alert-body">Available funds are between 10–30% of total spent.</p></div>';
    else html += '<div class="alert-card red"><p class="alert-title">Funds critical — request disbursement now</p><p class="alert-body">Available funds are below 10% of total spent.</p></div>';
  } else {
    html += '<div class="alert-card green"><p class="alert-title">Funds healthy</p><p class="alert-body">No spending recorded yet.</p></div>';
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
  const catSet = new Set();
  state.purchases.forEach(p => {
    const cats = purchaseCategories(p);
    if (cats.length) cats.forEach(c => catSet.add(c));
    else catSet.add('Other');
  });
  const catList = [...catSet].map(c => [c, spentForCat(c)]).filter(row => row[1] > 0).sort((a, b) => b[1] - a[1]);
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
    '<div class="entry-actions">' + actBtns('funds', f.id) + '</div></div>').join('');
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
      '<div class="entry-actions">' + actBtns('budget', b.id) + '</div></div>';
  }).join('');
  return head('Budget by category', 'Plan what each part should cost. Actual spend fills in from purchases.', 'budget') +
    (state.budget.length ? '<div class="entry-list">' + items + '</div>' : empty('No budget categories yet', 'Add a category like "Roofing" with a planned amount.'));
}
function renderActions() {
  const cols = [
    {id: 'pending', title: 'To do'},
    {id: 'progress', title: 'Doing'},
    {id: 'done', title: 'Done'}
  ];
  const dayLabel = d => {
    if (!d) return '<span class="due-pill none">No date</span>';
    const due = new Date(d + 'T00:00:00');
    if (!Number.isFinite(due.getTime())) return '<span class="due-pill none">No date</span>';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
    if (diff > 0) return '<span class="due-pill soon">D-' + diff + '</span>';
    if (diff === 0) return '<span class="due-pill today">Today</span>';
    return '<span class="due-pill late">' + Math.abs(diff) + 'd late</span>';
  };
  const board = cols.map(col => {
    const cards = state.actions.filter(a => (a.status || 'pending') === col.id)
      .sort((a, b) => (a.due || '').localeCompare(b.due || ''));
    return '<div class="kanban-col"><div class="kanban-head"><span>' + col.title + '</span><em>' + cards.length + '</em></div>' +
      '<div class="kanban-cards" data-drop="' + col.id + '">' +
      (cards.length ? cards.map(a => '<article class="kanban-card" draggable="true" data-id="' + a.id + '">' +
        '<div class="kanban-top"><p class="entry-name' + (a.status === 'done' ? ' done' : '') + '">' + esc(a.title) + '</p>' + actBtns('actions', a.id) + '</div>' +
        (a.notes ? '<p class="entry-sub">' + esc(a.notes) + '</p>' : '') +
        '<div class="kanban-foot">' + dayLabel(a.due) +
        '<span class="kanban-move"><button type="button" class="icon-btn icon-only" data-move="' + a.id + '" data-dir="-1" aria-label="Move left">' + ICO.left + '</button>' +
        '<button type="button" class="icon-btn icon-only" data-move="' + a.id + '" data-dir="1" aria-label="Move right">' + ICO.right + '</button></span></div></article>').join('') : '<p class="kanban-empty">Drop here</p>') +
      '</div></div>';
  }).join('');
  return head('Action board', 'Drag cards between columns, or tap the arrows.', 'actions') +
    (state.actions.length ? '<div class="kanban">' + board + '</div>' : empty('No actions yet', 'Add things like "Get quote for tiles".'));
}

function sellerQuoteRows() {
  const quoteRows = [];
  state.sellers.forEach(s => {
    const lines = Array.isArray(s.quoteLines) ? s.quoteLines : [];
    lines.forEach(l => quoteRows.push({
      sellerId: s.id,
      seller: l.seller || s.name || '',
      contact: l.contact || s.contact || '',
      item: l.item || '',
      qty: l.qty,
      rate: Number(l.rate) || 0,
      amount: lineAmount(l),
      status: s.status || ''
    }));
  });
  return quoteRows;
}

function filterSellerQuotes(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r =>
    String(r.item || '').toLowerCase().includes(q) ||
    String(r.seller || '').toLowerCase().includes(q) ||
    String(r.contact || '').toLowerCase().includes(q) ||
    String(r.status || '').toLowerCase().includes(q)
  );
}

function sellerQuoteBodyHtml(rows) {
  if (!rows.length) {
    const msg = sellerItemSearch.trim()
      ? 'No seller items match this search.'
      : 'No extracted seller items yet. Upload seller screenshots/photos to build this table.';
    return '<tr><td colspan="6" style="text-align:center;padding:18px;color:var(--ink-2)">' + msg + '</td></tr>';
  }
  return rows.map(r => '<tr><td>' + esc(r.item) + '</td><td>' + esc(r.seller) + '</td><td class="num">' + esc(r.qty || '') + '</td><td class="num">' + moneyDec(r.rate || 0) + '</td><td class="num">' + moneyDec(lineAmount(r)) + '</td><td>' + chip(r.status) + '</td></tr>').join('');
}

function applySellerItemSearch(value) {
  sellerItemSearch = value;
  const tbody = $('seller-quote-tbody');
  if (!tbody) return;
  tbody.innerHTML = sellerQuoteBodyHtml(filterSellerQuotes(sellerQuoteRows(), sellerItemSearch));
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
      const amount = lineAmount(l);
      const qty = Number(l.qty) || 0;
      const unit = Number(l.rate) > 0 ? Number(l.rate) : (qty > 0 ? amount / qty : 0);
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

  const filteredQuotes = filterSellerQuotes(sellerQuoteRows(), sellerItemSearch);

  const items = state.sellers.map(s => '<div class="entry"><div class="entry-top"><div><p class="entry-name">' + esc(s.name) + '</p>' +
    (s.contact ? '<p class="entry-sub">' + esc(s.contact) + '</p>' : '') + '</div>' + chip(s.status) + '</div>' +
    (Array.isArray(s.photos) && s.photos.length ? ('<div class="photo-list" style="margin-top:8px">' + s.photos.slice(0, 6).map((ph, i) => '<img src="' + esc(ph.thumb || '') + '" data-preview="seller" data-id="' + s.id + '" data-idx="' + i + '" alt="Seller photo">').join('') + '</div>') : '') +
    (Array.isArray(s.photoLinks) && s.photoLinks.length ? ('<div class="entry-meta">' + s.photoLinks.slice(0, 3).map((ln, i) => '<a href="' + esc(ln.webViewLink || ln.url || '#') + '" target="_blank" rel="noopener">Photo ' + (i + 1) + '</a>').join(' ') + '</div>') : '') +
    '<div class="entry-meta">' + (s.item ? '<span class="meta-item">' + esc(s.item) + '</span>' : '') +
    ((s.price !== '' && s.price != null) ? '<span class="meta-item">Quoted <strong>' + money(s.price) + '</strong></span>' : '') +
    (s.notes ? '<span class="meta-item">' + esc(s.notes) + '</span>' : '') + '</div>' +
    '<div class="entry-actions">' + actBtns('sellers', s.id) + '</div></div>').join('');
  const bestTable = intelligence.length
    ? ('<div class="dash-section"><p class="dash-title">Best Price Intelligence (from your receipts/screenshots)</p>' +
      '<div class="purchase-table-wrap"><table class="purchase-table"><thead><tr><th>Item</th><th>Category</th><th>Best seller</th><th>Best unit</th><th>Avg unit</th><th>Worst unit</th><th>Samples</th></tr></thead><tbody>' +
      intelligence.map(r => '<tr><td>' + esc(r.item) + '</td><td>' + esc(r.category) + '</td><td>' + esc(r.best.seller || 'Unknown') + '</td><td class="num">' + moneyDec(r.best.unit) + '</td><td class="num">' + moneyDec(r.avg) + '</td><td class="num">' + moneyDec(r.worst.unit) + '</td><td class="num">' + r.samples + '</td></tr>').join('') +
      '</tbody></table></div></div>')
    : '<div class="set-note">No comparable line-item prices yet. Add more screenshots/receipts with qty and amount to unlock best-price ranking.</div>';
  return head('Seller shortlist', 'Compare suppliers and contractor quotes. Auto-rank best item prices from your purchase screenshots.', 'sellers') +
    '<div class="purchase-toolbar"><input class="seller-search-field seller-item-search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Search seller items fast…" value="' + esc(sellerItemSearch) + '"></div>' +
    '<div class="purchase-table-wrap"><table class="purchase-table"><thead><tr><th>Item</th><th>Seller</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody id="seller-quote-tbody">' +
    sellerQuoteBodyHtml(filteredQuotes) +
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

  const cats = [...new Set(state.purchases.flatMap(p => purchaseCategories(p)))].sort();
  const catOpts = '<option value="">All categories</option>' + cats.map(c => '<option value="' + esc(c) + '"' + (purchaseCatFilter === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('');

  const q = purchaseSearch.toLowerCase();
  let filtered = state.purchases.filter(p => {
    const pcats = purchaseCategories(p);
    if (purchaseCatFilter && !pcats.includes(purchaseCatFilter) && (p.category || '') !== purchaseCatFilter) return false;
    const blob = ((p.item || '') + ' ' + (p.seller || '') + ' ' + pcats.join(' ') + ' ' + (p.receipt || '')).toLowerCase();
    if (q && !blob.includes(q)) return false;
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
    const displayPrice = purchaseTotal(p);
    rows += '<tr class="clickable" data-row-id="' + p.id + '">' +
      '<td>' + esc(p.date || '') + '</td>' +
      '<td class="item-cell">' + (p.thumb ? '<img src="' + p.thumb + '" class="thumb-sm" data-preview="purchase" data-id="' + p.id + '" alt="Receipt">' : '') + '<span>' + esc(p.item || '') + '</span></td>' +
      '<td>' + esc(p.seller || '') + '</td>' +
      '<td>' + catChips(p) + '</td>' +
      '<td class="num tight">' + money(displayPrice) + '</td>' +
      '<td>' + esc(p.receipt || '') + '</td>' +
      '<td>' + actBtns('purchases', p.id) + '</td></tr>';

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
  if (p.thumb) html += '<img src="' + p.thumb + '" class="detail-photo" data-preview="purchase" data-id="' + p.id + '" alt="Receipt">';
  html += '<dl class="detail-grid">';
  html += '<dt>Seller</dt><dd>' + esc(p.seller || '—') + '</dd>';
  html += '<dt>Date</dt><dd>' + esc(p.date || '—') + '</dd>';
  html += '<dt>Category</dt><dd>' + catChips(p) + '</dd>';
  if (p.receipt) html += '<dt>Receipt #</dt><dd>' + esc(p.receipt) + '</dd>';
  if (p.driveLink) html += '<dt>Drive</dt><dd><a href="' + esc(p.driveLink) + '" target="_blank" rel="noopener">' + esc(p.driveFolder || 'Open in Drive') + '</a></dd>';
  const displayTotal = purchaseTotal(p);
  html += '<dt>Total</dt><dd class="tight">' + moneyDec(displayTotal) + '</dd>';
  html += '</dl>';
  if (Array.isArray(p.lines) && p.lines.length) {
    html += '<table class="detail-lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th><th>Category</th></tr></thead><tbody>';
    p.lines.forEach(l => {
      html += '<tr><td>' + esc(l.item || '') + '</td><td class="num">' + esc(l.qty || '') + '</td><td class="num">' + fmtNum(l.rate) + '</td><td class="num tight">' + moneyDec(lineAmount(l)) + '</td><td>' + (l.category ? '<span class="chip cat">' + esc(normalizeCategory(l.category)) + '</span>' : '—') + '</td></tr>';
    });
    html += '<tr class="detail-total"><td colspan="3">Total</td><td class="num tight">' + moneyDec(displayTotal) + '</td><td></td></tr>';
    html += '</tbody></table>';
  }
  return html;
}

export function render() {
  computeSummary();
  const root = $('panel-root');
  if (!root) return;
  const renderer = {dashboard: renderDashboard, funds: renderFunds, budget: renderBudget, actions: renderActions, sellers: renderSellers, purchases: renderPurchases}[session.activeTab];
  root.innerHTML = renderer ? renderer() : renderDashboard();
  attach();
  updateSyncPill();
}

function attach() {
  const root = $('panel-root');
  if (!root) return;
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
  const sellerSearchEl = root.querySelector('.seller-item-search');
  if (sellerSearchEl) {
    sellerSearchEl.oninput = e => applySellerItemSearch(e.target.value);
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
    if (e.target.closest('[data-edit],[data-del],[data-preview]')) return;
    const id = tr.dataset.rowId;
    purchaseExpandedId = purchaseExpandedId === id ? null : id;
    render();
  });
  bindKanban(root);
}

function bindKanban(root) {
  const order = ['pending', 'progress', 'done'];
  root.querySelectorAll('.kanban-card').forEach(card => {
    card.ondragstart = e => { e.dataTransfer.setData('text/plain', card.dataset.id); card.classList.add('dragging'); };
    card.ondragend = () => card.classList.remove('dragging');
  });
  root.querySelectorAll('[data-drop]').forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('drag-over'); };
    col.ondragleave = () => col.classList.remove('drag-over');
    col.ondrop = async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const it = state.actions.find(a => a.id === e.dataTransfer.getData('text/plain'));
      if (!it || it.status === col.dataset.drop) return;
      it.status = col.dataset.drop;
      await persist('actions');
      render();
      if (settings.driveToken) scheduleCsvSync();
    };
  });
  root.querySelectorAll('[data-move]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const it = state.actions.find(a => a.id === b.dataset.move);
    if (!it) return;
    let i = order.indexOf(it.status || 'pending');
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(order.length - 1, i + Number(b.dataset.dir)));
    it.status = order[i];
    await persist('actions');
    render();
    if (settings.driveToken) scheduleCsvSync();
  });
}

function inlineAiHtml() {
  return '<div class="inline-ai" id="inline-ai"><p>Paste your AI key once so scan can run. It is saved to your Drive profile.</p>' +
    '<div class="form-grid">' +
    '<div class="field"><label>Provider</label><select id="m-ai-provider">' + providerOptionsHtml() + '</select></div>' +
    '<div class="field"><label>API key</label><input id="m-ai-key" type="password" placeholder="sk-… or your provider key" autocomplete="off"></div></div>' +
    '<div id="m-ai-custom" style="display:none;margin-top:10px">' +
    '<div class="field wide"><label class="req">API base URL</label><input id="m-ai-base" value="' + esc(settings.apiBase) + '" placeholder="https://api.example.com/v1" autocomplete="off"></div></div>' +
    modelPickerHtml('m-ai') + '</div>';
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
    p = p || {name: '', contact: '', item: '', price: '', status: 'shortlisted', notes: '', photos: [], photoLinks: [], quoteLines: []};
    const hasKey = !!settings.apiKey;
    const photos = existingFormPhotos(p, 'sellers');
    const lines = (Array.isArray(p.quoteLines) && p.quoteLines.length ? p.quoteLines : []).map(l => Object.assign({}, l, {
      seller: l.seller || p.name || '',
      contact: l.contact || p.contact || ''
    }));
    return photoFieldHtml({
      photos, hasKey,
      kind: 'seller', recordId: p.id || '', alt: 'Seller photo',
      hint: 'Each quote photo can be a different shop. AI fills seller name and contact on every line.',
      ocrLabel: hasKey ? 'Re-scan with AI' : 'Extract with AI',
      extraHtml: hasKey ? '' : inlineAiHtml()
    }) +
      '<div class="receipt-meta">' +
      '<div class="field"><label>Name</label><input id="m-name" value="' + esc(p.name) + '" placeholder="Default if a row is blank" autocomplete="off"></div>' +
      '<div class="field"><label>Contact</label><input id="m-contact" value="' + esc(p.contact) + '" placeholder="Default if a row is blank" autocomplete="off"></div>' +
      '<div class="field"><label>Status</label><select id="m-status">' +
      '<option value="shortlisted"' + (p.status === 'shortlisted' ? ' selected' : '') + '>Shortlisted</option>' +
      '<option value="contacted"' + (p.status === 'contacted' ? ' selected' : '') + '>Contacted</option>' +
      '<option value="selected"' + (p.status === 'selected' ? ' selected' : '') + '>Selected</option>' +
      '<option value="rejected"' + (p.status === 'rejected' ? ' selected' : '') + '>Rejected</option></select></div>' +
      '<div class="field"><label>For</label><input list="category-options" id="m-item" value="' + esc(p.item) + '" placeholder="e.g. Roof tiles"></div></div>' +
      '<p class="field-hint receipt-table-label">Quote line items — each row can be a different shop. AI fills this; tap a cell to correct.</p>' +
      purchaseLinesHtml(lines, {skipCategory: true, withSeller: true}) +
      '<div class="receipt-total-row">' +
      '<div class="field"><label>Quoted (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-price" value="' + esc(p.price) + '" placeholder="Optional"></div></div>' +
      '<div class="field wide" style="margin-top:12px"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="Optional"></div>';
  }
  if (kind === 'purchases') {
    p = p || {item: '', category: '', seller: '', price: '', date: todayStr(), receipt: '', thumb: null, lines: []};
    const hasKey = !!settings.apiKey;
    const photos = existingFormPhotos(p, 'purchases');
    const lines = parsePurchaseLines(p);
    return photoFieldHtml({
      photos, hasKey,
      kind: 'purchase', recordId: p.id || '', alt: 'Receipt',
      hint: 'For multi-page receipts, add all photos first. AI reads every page into one table.',
      ocrLabel: hasKey ? 'Re-scan with AI' : 'Scan receipt',
      extraHtml: hasKey ? '' : inlineAiHtml()
    }) +
      '<div class="receipt-meta">' +
      '<div class="field"><label>Seller</label><input id="m-seller" value="' + esc(p.seller) + '" placeholder="Shop / company" autocomplete="off"></div>' +
      '<div class="field"><label>Date</label><input type="date" id="m-date" value="' + esc(p.date || todayStr()) + '"></div>' +
      '<div class="field"><label>Receipt no.</label><input id="m-receipt" value="' + esc(p.receipt) + '" placeholder="Optional"></div></div>' +
      '<div class="field wide"><label>Categories</label>' +
      categoryPillsHtml(purchaseCategories(p)) +
      '<p class="field-hint">Tap all that apply. AI also tags each line — change a line if it guessed wrong.</p>' +
      '<button type="button" class="ocr-btn" id="m-fill-ai" style="margin-top:8px">Fill missing with AI</button>' +
      '<p class="field-hint" id="m-fill-status"></p></div>' +
      '<p class="field-hint receipt-table-label">Line items — AI fills this; tap a cell to correct.</p>' +
      purchaseLinesHtml(lines) +
      '<div class="receipt-total-row">' +
      '<div class="field"><label class="req">Total (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-price" value="' + esc(p.price) + '" placeholder="Grand total"></div>' +
      '<div class="field"><label class="req">Summary</label><input id="m-item" value="' + esc(p.item) + '" placeholder="AI writes a short label" autocomplete="off"></div></div>';
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
    sellers: 'Snap or pick quote photos. Each photo can be a different shop — AI fills name, contact, and lines.',
    purchases: 'Snap or pick a receipt. AI fills items, categories, and a short label. You can still correct anything.'
  }[kind];
  const modal = $('modal');
  const overlay = $('overlay');
  if (!modal || !overlay) return;
  modal.innerHTML =
    '<div class="modal-head"><p class="modal-title">' + title + '</p>' +
    '<button class="modal-close" id="modal-close" aria-label="Close">&times;</button></div>' +
    '<p class="modal-sub">' + sub + '</p>' +
    '<div class="modal-body">' + formBody(kind, rec) + '<p class="error-text" id="modal-error"></p></div>' +
    '<div class="modal-actions"><button class="btn-primary" id="modal-save">' + (rec ? 'Save changes' : 'Save') + '</button>' +
    '<button class="btn-cancel" id="modal-cancel">Cancel</button></div>';
  overlay.classList.add('show');
  bindModal();
  if (kind !== 'purchases' && kind !== 'sellers') setTimeout(() => {
    const el = $('m-amount') || $('m-title') || $('m-name');
    if (el) el.focus();
  }, 40);
}

export function closeModal() {
  const overlay = $('overlay');
  if (overlay) overlay.classList.remove('show');
  session.editing = null;
  session.editKind = null;
  session.photoCleared = false;
  saveBusy = false;
  clearPendingPhoto();
}

function bindModal() {
  const closeBtn = $('modal-close'); if (closeBtn) closeBtn.onclick = closeModal;
  const cancelBtn = $('modal-cancel'); if (cancelBtn) cancelBtn.onclick = closeModal;
  const saveBtn = $('modal-save'); if (saveBtn) saveBtn.onclick = saveModal;
  const modal = $('modal');
  if (modal) modal.onkeydown = e => {
    if (e.key !== 'Enter' || !e.target || e.target.id === 'modal-save') return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.target.closest && e.target.closest('#inline-ai')) return;
    e.preventDefault();
    saveModal();
  };
  bindAlbumControls(modal, maybeScanAfterPhoto);
  const ocr = $('m-ocr'); if (ocr) ocr.onclick = startReceiptScan;
  wireModelPicker('m-ai', 'm-ai-custom');
  bindLineTable();
  const pills = $('m-cat-pills');
  if (pills) pills.onclick = e => {
    const b = e.target.closest('.cat-pill');
    if (!b) return;
    b.classList.toggle('on');
    prefillEmptyLineCategories();
  };
  const fillBtn = $('m-fill-ai');
  if (fillBtn) fillBtn.onclick = () => fillMissingWithAi();
  if (session.editKind === 'purchases') prefillEmptyLineCategories();
  const sumEl = $('m-item');
  if (sumEl) sumEl.addEventListener('input', () => { sumEl.dataset.autogen = '0'; });
}

function showErr(msg) {
  const e = $('modal-error');
  if (!e) { toast(msg); return; }
  e.textContent = msg;
  e.classList.add('show');
}

async function attachSellerPhotos(obj, photos) {
  const list = (photos || []).filter(Boolean);
  if (!list.length) return;
  const links = [];
  if (settings.driveToken) {
    for (const ph of list) {
      if (!ph.originalFile) {
        links.push({
          id: ph.driveFileId || '',
          webViewLink: ph.webViewLink || '',
          folderPath: ''
        });
        continue;
      }
      try {
        const up = await uploadSellerOriginalToDrive(ph.originalFile, {
          name: obj.name, item: obj.item, date: todayStr(), ext: ph.ext
        });
        links.push(up ? {id: up.id, webViewLink: up.webViewLink, folderPath: up.folderPath || ''} : {});
      } catch (e) {
        links.push({});
      }
    }
  }
  obj.photoLinks = links.filter(ln => ln && (ln.id || ln.webViewLink));
  obj.photos = list.map((ph, i) => persistablePhoto(ph, links[i]));
}

function sellerRecordFromGroup(g, shared) {
  const quoteLines = (g.lines || []).map(l => ({
    item: l.item, qty: l.qty, rate: l.rate, amount: l.amount,
    seller: l.seller || g.name, contact: l.contact || g.contact
  })).filter(l => l.item || l.amount !== '');
  let price = shared.priceOverride;
  if (price === undefined || price === '' || price == null) {
    const sum = sumLines(quoteLines);
    price = sum > 0 ? Math.round(sum * 100) / 100 : '';
  }
  return {
    name: g.name,
    contact: g.contact || shared.contact || '',
    item: shared.item || (quoteLines[0] && quoteLines[0].item) || '',
    price,
    status: shared.status,
    notes: shared.notes,
    quoteLines
  };
}

async function saveModal() {
  if (saveBusy) return;
  const k = session.editKind, val = id => { const el = $(id); return el ? el.value : ''; };
  if (!k || !state[k]) return showErr('Could not save: invalid form state. Close and open again.');
  const editing = session.editing;
  setSaveBusy(true);
  let obj;
  let extraSellers = [];
  let sellerBatchNote = '';
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
    const c = val('m-contact').trim();
    const pr = val('m-price');
    if (pr !== '' && (!finiteNum(pr) || +pr < 0)) return showErr('Enter a valid quoted price, or leave it blank.');
    const {groups, unnamed} = readSellerQuoteGroups({name: n, contact: c});
    if (unnamed.length) return showErr('Every quote row needs a seller name, or fill Name at the top.');
    if (!n && !groups.length) return showErr('Enter a seller name, or add it on a quote row.');
    const shared = {contact: c, item: val('m-item').trim(), status: val('m-status'), notes: val('m-notes').trim()};
    const pending = pendingPhotos();

    const keepExistingPhotos = () => {
      if (session.photoCleared) {
        obj.photos = [];
        obj.photoLinks = [];
      } else if (editing) {
        obj.photos = Array.isArray(editing.photos) ? editing.photos.slice() : [];
        obj.photoLinks = Array.isArray(editing.photoLinks) ? editing.photoLinks.slice() : [];
      }
    };

    if (!groups.length) {
      obj = sellerRecordFromGroup({name: n, contact: c, lines: []}, Object.assign({}, shared, {priceOverride: pr === '' ? '' : +pr}));
      if (pending.length) {
        await attachSellerPhotos(obj, pending);
        if (!settings.driveToken) toast('Saved on this device. Sign in to keep the original photos in Drive.');
      } else keepExistingPhotos();
    } else {
      let primaryIdx = 0;
      if (editing) {
        const editKey = sellerNameKey(n || editing.name);
        const found = groups.findIndex(g => g.key === editKey);
        if (found >= 0) primaryIdx = found;
      }
      const claimed = new Set();
      groups.forEach(g => {
        g.photos = [];
        (g.photoIndexes || []).forEach(i => {
          if (claimed.has(i) || !pending[i]) return;
          g.photos.push(pending[i]);
          claimed.add(i);
        });
      });
      pending.forEach((ph, i) => {
        if (claimed.has(i)) return;
        const g = groups.find(x => x.key === sellerNameKey(ph.ocrSeller));
        if (g) { g.photos.push(ph); claimed.add(i); }
      });
      pending.forEach((ph, i) => {
        if (claimed.has(i)) return;
        const target = groups[primaryIdx] || groups[0];
        if (target) { target.photos.push(ph); claimed.add(i); }
      });
      const primary = groups[primaryIdx];
      const others = groups.filter((_, i) => i !== primaryIdx);
      const priceOverride = groups.length === 1 && pr !== '' ? +pr : undefined;
      obj = sellerRecordFromGroup(primary, Object.assign({}, shared, {priceOverride}));
      if (pending.length) {
        if (primary.photos && primary.photos.length) await attachSellerPhotos(obj, primary.photos);
        else keepExistingPhotos();
        if (!settings.driveToken) toast('Saved on this device. Sign in to keep the original photos in Drive.');
      } else keepExistingPhotos();
      for (const g of others) {
        const extra = sellerRecordFromGroup(g, shared);
        if (pending.length && g.photos && g.photos.length) await attachSellerPhotos(extra, g.photos);
        else { extra.photos = []; extra.photoLinks = []; }
        extraSellers.push(extra);
      }
      if (others.length) {
        sellerBatchNote = editing
          ? ('Updated this seller and added ' + others.length + ' more.')
          : ('Saved ' + groups.length + ' sellers.');
      }
    }
  } else if (k === 'purchases') {
    const form = readPurchaseForm();
    if (!form.item) return showErr('Enter a summary or at least one line item.');
    if (form.price === '' || !finiteNum(form.price) || +form.price < 0) return showErr('Enter a valid total amount.');
    const cat = form.category || '';
    const cats = (form.categories && form.categories.length) ? form.categories : (cat ? [cat] : []);
    const album = pendingPhotos();
    const firstPending = album[0] || null;
    const thumb = session.photoCleared ? null : ((firstPending && firstPending.thumbDataUrl) || (session.editing ? session.editing.thumb : null) || null);
    const summary = form.item || summarizePurchase(form.seller, form.lines);
    obj = {
      item: summary,
      category: cats[0] || '',
      categories: cats,
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
    if (album.length && settings.driveToken) {
      try {
        const oldIds = [];
        if (session.editing && Array.isArray(session.editing.driveFileIds)) oldIds.push(...session.editing.driveFileIds.filter(Boolean));
        else if (session.editing && session.editing.driveFileId) oldIds.push(session.editing.driveFileId);
        for (const id of oldIds) await deleteDriveFile(id);
        const uploaded = [];
        for (const ph of album) {
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
    } else if (album.length && !settings.driveToken) {
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
  if (!obj) return;
  obj.updatedAt = new Date().toISOString();
  if (editing) Object.assign(editing, obj);
  else { obj.id = uid(); state[k].push(obj); }
  extraSellers.forEach(extra => {
    extra.id = uid();
    extra.updatedAt = obj.updatedAt;
    state.sellers.push(extra);
  });
  await persist(k);
  closeModal();
  render();
  if (sellerBatchNote) toast(sellerBatchNote);
  if (settings.driveToken) scheduleCsvSync();
  } catch (e) {
    console.error(e);
    showErr(e && e.message ? e.message : 'Could not save. Please try again.');
  } finally {
    const overlay = $('overlay');
    if (overlay && overlay.classList.contains('show')) setSaveBusy(false);
    else saveBusy = false;
  }
}

export function renderSettings() {
  const who = settings.user ? (settings.user.name || settings.user.email) : '';
  const settingsModal = $('settings-modal');
  if (!settingsModal) return;
  settingsModal.innerHTML =
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
  const setClose = $('set-close');
  if (setClose) setClose.onclick = () => { const ov = $('settings-overlay'); if (ov) ov.classList.remove('show'); };
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
  const setSave = $('set-save');
  if (setSave) setSave.onclick = async () => {
    const providerEl = $('set-provider');
    const keyEl = $('set-key');
    if (providerEl) settings.provider = providerEl.value;
    if (keyEl) settings.apiKey = keyEl.value.trim();
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
    const ov = $('settings-overlay'); if (ov) ov.classList.remove('show');
  };
  const csvExport = $('csv-export'); if (csvExport) csvExport.onclick = downloadCSV;
  const csvImport = $('csv-import'); const csvFile = $('csv-file');
  if (csvImport && csvFile) csvImport.onclick = () => csvFile.click();
  if (csvFile) csvFile.onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importCSVFile(f); };
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

function syncChromeClasses() {
  const shown = id => {
    const el = $(id);
    return !!(el && el.classList.contains('show'));
  };
  const body = document.body;
  if (!body) return;
  body.classList.toggle('overlay-open', shown('overlay') || shown('settings-overlay'));
  body.classList.toggle('lightbox-open', shown('lightbox'));
  body.classList.toggle('login-open', shown('login-screen'));
  body.classList.toggle('chat-open', shown('chat-panel'));
}

function watchChrome() {
  syncChromeClasses();
  if (typeof MutationObserver === 'undefined') return;
  const obs = new MutationObserver(syncChromeClasses);
  ['overlay', 'settings-overlay', 'lightbox', 'login-screen', 'chat-panel'].forEach(id => {
    const el = $(id);
    if (el) obs.observe(el, {attributes: true, attributeFilter: ['class']});
  });
}

export function bindShell() {
  const tabs = $('tabs');
  if (tabs) tabs.addEventListener('click', e => {
    const b = e.target.closest('.tab-btn');
    if (!b) return;
    session.activeTab = b.dataset.tab;
    localStorage.setItem('sl.tab', session.activeTab);
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === session.activeTab));
    render();
  });
  const overlay = $('overlay');
  if (overlay) overlay.addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  bindLightboxShell();
  bindPhotoPreview(document);
  const openSettings = $('open-settings');
  if (openSettings) openSettings.onclick = () => {
    renderSettings();
    const ov = $('settings-overlay');
    if (ov) ov.classList.add('show');
  };
  const settingsOverlay = $('settings-overlay');
  if (settingsOverlay) settingsOverlay.addEventListener('click', e => { if (e.target.id === 'settings-overlay') settingsOverlay.classList.remove('show'); });
  const syncPill = $('sync-pill');
  if (syncPill) syncPill.addEventListener('click', async () => {
    if (!settings.driveToken) {
      startGoogleLogin(false);
      return;
    }
    if (session.syncStatus === 'syncing') return;
    try { await hub.reconcileLedgerWithDrive(); }
    catch (e) { toast(e.message || 'Drive sync failed'); }
  });
  const fab = $('fab-add');
  if (fab) fab.onclick = () => {
    const k = session.activeTab === 'dashboard' ? 'purchases' : session.activeTab;
    if (TITLES[k]) openModal(k, null);
  };
  watchChrome();
}

hub.render = render;
hub.updateSyncPill = updateSyncPill;
