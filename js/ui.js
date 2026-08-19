import {TITLES, CHIP, CATEGORIES} from './config.js?v=20260819d';
import {state, settings, session, persist, saveSettings} from './store.js?v=20260819d';
import {$, esc, money, moneyDec, fmtNum, todayStr, uid, finiteNum, toast, normalizeCategory, lineAmount, sumLines, purchaseCategories, summarizePurchase, guessCategoryFromItem, purchasePayee, isBankName, allTradeCategories, refreshTradeDatalist} from './util.js?v=20260819d';
import {buildCatalog, filterCatalog, catalogPage, CATALOG_PAGE_SIZE, parseShoppingList, matchShoppingList, groupQuoteBySeller, aiAssistMatches, applyAiMatches, catalogCategories, sellerPhotoList} from './catalog.js?v=20260819d';
import {
  PAY_METHODS, payMethodLabel, purchaseTotal, labourTotal, loanReceived, ownCash, fundsIn,
  totalSpent, inHand, budgetMaterialsPlanned, budgetLabourPlanned, budgetPlan, totalPlan,
  extraNeeded, overdrawn, spentMaterialsForCat, spentLabourForCat, paidToRows,
  allPayments, labourPayments, labourBudgetPlanned, labourByTrade, labourByPayee, defaultSpendKind,
  materialsSpent, labourSpent
} from './finance.js?v=20260819d';
import {hub} from './hub.js?v=20260819d';
import {providerOptionsHtml, modelPickerHtml, wireModelPicker, readModelValue, chatCompletionsUrl} from './ai.js?v=20260819d';
import {maybeScanAfterPhoto, startReceiptScan, purchaseLinesHtml, bindLineTable, readPurchaseForm, readLinesFromTable, readSellerQuoteGroups, sellerNameKey, categoryPillsHtml, prefillEmptyLineCategories, fillMissingWithAi} from './receipts.js?v=20260819d';
import {bindPhotoPreview, bindLightboxShell, bindAlbumControls, photoFieldHtml, existingFormPhotos, pendingPhotos, persistablePhoto, clearPendingPhoto} from './photos.js?v=20260819d';
import {driveApiEnableUrl, ensureDriveFolder, saveProfileToDrive, deleteDriveFile, uploadOriginalToDrive, uploadSellerOriginalToDrive, scheduleCsvSync, syncCsvToDrive, updateSyncPill, pullCsvFromDrive} from './drive.js?v=20260819d';
import {downloadCSV, importCSVFile} from './csv.js?v=20260819d';
import {googleLogout, startGoogleLogin} from './auth.js?v=20260819d';

let sellerItemSearch = '';
let sellerCatFilter = '';
let sellerCatalogPage = 1;
let catalogCache = [];
let shopListDraft = '';
let saveBusy = false;
let paidSearch = '';
let paidKindFilter = '';

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

function computeSummary() {
  const loan = loanReceived(), cash = ownCash(), spent = totalSpent(), avail = inHand();
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

function methodSelectHtml(id, selected) {
  const sel = PAY_METHODS.some(m => m.id === selected) ? selected : 'cash';
  return '<select id="' + id + '">' +
    PAY_METHODS.map(m => '<option value="' + m.id + '"' + (sel === m.id ? ' selected' : '') + '>' + m.label + '</option>').join('') +
    '</select>';
}

function financeStripHtml() {
  const plan = totalPlan(), fin = fundsIn(), spent = totalSpent(), hand = inHand(), extra = extraNeeded(), over = overdrawn();
  return '<div class="fund-strip">' +
    '<div class="fund-grid">' +
    '<div class="fund-cell"><p class="k">Plan</p><p class="v">' + money(plan) + '</p></div>' +
    '<div class="fund-cell"><p class="k">Funds in</p><p class="v">' + money(fin) + '</p></div>' +
    '<div class="fund-cell"><p class="k">Spent</p><p class="v spend">' + money(spent) + '</p></div>' +
    '<div class="fund-cell"><p class="k">In hand</p><p class="v' + (hand < 0 ? ' neg' : '') + '">' + money(hand) + '</p></div>' +
    '<div class="fund-cell"><p class="k">Extra needed</p><p class="v' + (extra > 0 ? ' warn' : '') + '">' + money(extra) + '</p></div>' +
    '</div>' +
    (over > 0 ? '<p class="fund-note">Already overdrawn ' + money(over) + ' — spent more than funds in.</p>' : '<p class="fund-note">Extra needed is how much more capital the plan still requires (plan − funds in).</p>') +
    '</div>';
}

function spendInRange(from, to) {
  const inWin = rec => {
    const t = rec.date ? new Date(rec.date).getTime() : 0;
    return t >= from && t <= to;
  };
  const shop = (state.purchases || []).filter(inWin).reduce((s, p) => s + purchaseTotal(p), 0);
  const lab = (state.labour || []).filter(inWin).reduce((s, p) => s + labourTotal(p), 0);
  return shop + lab;
}

function renderDashboard() {
  const loan = loanReceived(), cash = ownCash(), spent = totalSpent(), avail = inHand();
  const plan = totalPlan(), extra = extraNeeded(), over = overdrawn();
  const remainPlan = Math.max(0, plan - spent);

  let html = '<div class="summary">' +
    '<div class="avail-block"><div><p class="avail-label">In hand now</p>' +
    '<p class="avail-value' + (avail < 0 ? ' negative' : '') + '" id="avail-value">' + money(avail) + '</p></div>' +
    '<p class="avail-hint">Funds in − shop bills − labour payments</p></div>' +
    financeStripHtml() +
    '<div class="stat-grid">' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--loan)"></span>Loan received</p><p class="stat-value" id="stat-loan" style="color:var(--loan)">' + money(loan) + '</p></div>' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--ink-2)"></span>Own cash</p><p class="stat-value" id="stat-cash">' + money(cash) + '</p></div>' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--spend)"></span>Spent</p><p class="stat-value" id="stat-spent" style="color:var(--spend)">' + money(spent) + '</p></div>' +
    '<div class="stat-card"><p class="stat-label"><span class="stat-dot" style="background:var(--accent)"></span>Pending</p><p class="stat-value" id="stat-pending">' + state.actions.filter(a => a.status !== 'done').length + '</p></div>' +
    '</div></div>';

  const now = Date.now();
  const d30 = now - 30 * 86400000;
  const d60 = now - 60 * 86400000;
  const spend30 = spendInRange(d30, now);
  const spendPrev30 = spendInRange(d60, d30 - 1);
  const trendPct = spendPrev30 > 0 ? ((spend30 - spendPrev30) / spendPrev30) * 100 : 0;
  const catTotals = {};
  (state.budget || []).forEach(b => {
    const c = b.category || 'Uncategorized';
    catTotals[c] = (catTotals[c] || 0) + spentMaterialsForCat(c) + spentLabourForCat(c);
  });
  (state.purchases || []).forEach(p => purchaseCategories(p).forEach(c => {
    if (catTotals[c] == null) catTotals[c] = spentMaterialsForCat(c) + spentLabourForCat(c);
  }));
  (state.labour || []).forEach(p => {
    const c = p.category || 'Uncategorized';
    if (catTotals[c] == null) catTotals[c] = spentMaterialsForCat(c) + spentLabourForCat(c);
  });
  const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
  const payees = paidToRows();
  const topPayee = payees[0];
  html += '<div class="dash-section"><p class="dash-title">Smart insights</p><div class="insights-grid">' +
    '<div class="insight-card"><p class="k">30d spend</p><p class="v">' + money(spend30) + '</p></div>' +
    '<div class="insight-card"><p class="k">30d trend</p><p class="v ' + (trendPct > 0 ? 'bad' : 'good') + '">' + (spendPrev30 ? ((trendPct > 0 ? '+' : '') + trendPct.toFixed(1) + '%') : '—') + '</p></div>' +
    '<div class="insight-card"><p class="k">Top trade</p><p class="v">' + esc(topCat ? topCat[0] : '—') + '</p><p class="s">' + money(topCat ? topCat[1] : 0) + '</p></div>' +
    '<div class="insight-card"><p class="k">Top payee</p><p class="v">' + esc(topPayee ? topPayee.name : '—') + '</p><p class="s">' + money(topPayee ? topPayee.total : 0) + '</p></div>' +
    '</div></div>';

  html += '<div class="dash-section"><p class="dash-title">Fund health</p>';
  if (over > 0) {
    html += '<div class="alert-card red"><p class="alert-title">Overdrawn</p><p class="alert-body">Spent ' + money(over) + ' more than funds in. Add a loan tranche or own cash.</p></div>';
  } else if (remainPlan > 0) {
    const ratio = avail / remainPlan;
    if (ratio > 0.3) html += '<div class="alert-card green"><p class="alert-title">Funds healthy</p><p class="alert-body">In hand covers more than 30% of the remaining plan.</p></div>';
    else if (ratio >= 0.1) html += '<div class="alert-card yellow"><p class="alert-title">Running low — request next tranche soon</p><p class="alert-body">In hand is 10–30% of remaining plan (' + money(remainPlan) + ' left to spend).</p></div>';
    else html += '<div class="alert-card red"><p class="alert-title">Funds critical — request disbursement now</p><p class="alert-body">In hand is below 10% of remaining plan. Extra needed: ' + money(extra) + '.</p></div>';
  } else if (spent > 0) {
    html += '<div class="alert-card green"><p class="alert-title">Plan covered</p><p class="alert-body">Spend is within the planned total. Extra needed: ' + money(extra) + '.</p></div>';
  } else {
    html += '<div class="alert-card green"><p class="alert-title">Funds healthy</p><p class="alert-body">No spending recorded yet.</p></div>';
  }
  const avgDaily = spend30 / 30;
  if (avgDaily > 0) {
    const runwayDays = Math.round(Math.max(0, avail) / avgDaily);
    const next30 = Math.round(avgDaily * 30);
    html += '<div class="alert-card green"><p class="alert-title">Projected runway</p>' +
      '<p class="alert-body">At current spending rate, funds last ~' + runwayDays + ' more days.</p></div>' +
      '<div class="alert-card green"><p class="alert-title">Next disbursement suggestion</p>' +
      '<p class="alert-body">Request ' + money(next30) + ' to cover next 30 days based on average spending.</p></div>';
  }
  html += '</div>';

  if (state.budget.length) {
    html += '<div class="dash-section"><p class="dash-title">Budget vs Actual</p><table class="dash-table"><thead><tr>' +
      '<th>Trade</th><th>Materials</th><th>Labour</th><th>Plan</th><th>Spent</th><th>Remaining</th></tr></thead><tbody>';
    state.budget.forEach(b => {
      const matP = budgetMaterialsPlanned(b), labP = budgetLabourPlanned(b);
      const matS = spentMaterialsForCat(b.category), labS = spentLabourForCat(b.category);
      const bud = budgetPlan(b), sp = matS + labS, rem = bud - sp;
      const overRow = rem < 0;
      html += '<tr><td>' + esc(b.category) + '</td>' +
        '<td class="dash-stat">' + money(matS) + ' / ' + money(matP) + '</td>' +
        '<td class="dash-stat">' + money(labS) + ' / ' + money(labP) + '</td>' +
        '<td class="dash-stat">' + money(bud) + '</td>' +
        '<td class="dash-stat">' + money(sp) + '</td>' +
        '<td class="dash-stat" style="color:' + (rem < 0 ? 'var(--spend)' : 'var(--accent)') + '">' + money(rem) +
        (overRow ? ' <span class="over-badge">OVER</span>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  if (payees.length) {
    html += '<div class="dash-section"><p class="dash-title">Top payees</p><table class="dash-table"><thead><tr><th>Payee</th><th>Materials</th><th>Labour</th><th>Total</th></tr></thead><tbody>';
    payees.slice(0, 5).forEach(row => {
      html += '<tr><td>' + esc(row.name) + '</td><td class="dash-stat">' + money(row.materials) + '</td><td class="dash-stat">' + money(row.labour) + '</td><td class="dash-stat">' + money(row.total) + '</td></tr>';
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
function budgetSpendCell(spent, planned) {
  const over = planned > 0 && spent > planned;
  const noPlan = planned <= 0 && spent > 0;
  let bar = '';
  if (planned > 0 || spent > 0) {
    const w = planned > 0 ? Math.min(100, spent / planned * 100) : 100;
    bar = '<div class="cell-bar"><span class="' + (over || noPlan ? 'over' : '') + '" style="width:' + w + '%"></span></div>';
  }
  return bar + '<span class="cell-amt' + (over || noPlan ? ' over' : '') + '">' + money(spent) + '</span>' +
    (planned > 0 ? '<span class="cell-plan">/ ' + money(planned) + '</span>' : (noPlan ? ' <span class="over-badge">NO PLAN</span>' : ''));
}

function registerTradeCategory(name) {
  const c = String(name || '').trim();
  if (!c || CATEGORIES.includes(c)) return;
  if (!settings.tradeCategories) settings.tradeCategories = [];
  if (!settings.tradeCategories.includes(c)) {
    settings.tradeCategories.push(c);
    saveSettings();
  }
}

function renderBudget() {
  if (!state.budget.length) {
    refreshTradeDatalist();
    return head('Budget by trade', 'Your trade template: one row per part of the build. Materials or labour can be 0.', 'budget') +
      empty('No trades yet', 'Tap + Add to create Plumbing, Foundation, Electrical… Set materials and/or labour planned (0 is ok).');
  }

  const plan = totalPlan();
  const fin = fundsIn();
  const spent = totalSpent();
  const hand = inHand();
  const extra = extraNeeded();
  const over = overdrawn();
  const matPlanned = state.budget.reduce((s, b) => s + budgetMaterialsPlanned(b), 0);
  const labPlanned = labourBudgetPlanned();
  const matSpent = materialsSpent();
  const labSpent = labourSpent();
  const remainPlan = plan - spent;
  const pct = plan > 0 ? Math.round(spent / plan * 100) : 0;

  const matByTrade = state.budget.map(b => ({
    trade: b.category,
    spent: spentMaterialsForCat(b.category),
    planned: budgetMaterialsPlanned(b)
  })).filter(r => r.planned > 0 || r.spent > 0)
    .sort((a, b) => Math.max(b.spent, b.planned) - Math.max(a.spent, a.planned));

  const labByTrade = state.budget.map(b => ({
    trade: b.category,
    spent: spentLabourForCat(b.category),
    planned: budgetLabourPlanned(b)
  })).filter(r => r.planned > 0 || r.spent > 0)
    .sort((a, b) => Math.max(b.spent, b.planned) - Math.max(a.spent, a.planned));

  let html = head('Budget by trade', 'Plan materials and labour per trade. Charts compare spent vs planned for each envelope.', 'budget');

  html += '<div class="page-summary budget-summary">' +
    '<div class="insights-grid budget-stats">' +
    '<div class="insight-card"><p class="k">Plan</p><p class="v">' + money(plan) + '</p><p class="s">Mat ' + money(matPlanned) + ' · Lab ' + money(labPlanned) + '</p></div>' +
    '<div class="insight-card"><p class="k">Spent</p><p class="v bad">' + money(spent) + '</p><p class="s">Mat ' + money(matSpent) + ' · Lab ' + money(labSpent) + '</p></div>' +
    '<div class="insight-card"><p class="k">Plan remaining</p><p class="v ' + (remainPlan < 0 ? 'bad' : 'good') + '">' + money(remainPlan) + '</p></div>' +
    '<div class="insight-card"><p class="k">Plan used</p><p class="v ' + (pct > 100 ? 'bad' : '') + '">' + (plan ? pct + '%' : '—') + '</p></div>' +
    '</div>';

  if (plan > 0) {
    html += '<div class="chart-gauge"><div class="chart-gauge-bar"><span style="width:' + Math.min(100, pct) + '%" class="' + (pct > 100 ? 'over' : '') + '"></span></div>' +
      '<p class="chart-gauge-note">' + money(spent) + ' of ' + money(plan) + ' plan spent' +
      (remainPlan < 0 ? ' · <strong style="color:var(--spend)">Over plan by ' + money(-remainPlan) + '</strong>' : '') + '</p></div>';
  }

  html += '<div class="insights-grid budget-funds">' +
    '<div class="insight-card"><p class="k">Funds in</p><p class="v">' + money(fin) + '</p></div>' +
    '<div class="insight-card"><p class="k">In hand</p><p class="v ' + (hand < 0 ? 'bad' : 'good') + '">' + money(hand) + '</p></div>' +
    '<div class="insight-card"><p class="k">Extra needed</p><p class="v ' + (extra > 0 ? 'bad' : '') + '">' + money(extra) + '</p>' +
    '<p class="s">Capital still required (plan − funds in)</p></div>' +
    (over > 0 ? '<div class="insight-card"><p class="k">Overdrawn</p><p class="v bad">' + money(over) + '</p><p class="s">Spent more than funds in</p></div>' : '') +
    '</div></div>';

  if (matByTrade.length || labByTrade.length) {
    html += '<div class="budget-charts">';
    if (matByTrade.length) {
      html += '<div class="dash-section chart-panel"><p class="dash-title">Materials by trade</p>' +
        '<p class="panel-desc" style="margin:-6px 0 10px">Green = spent · faint = planned</p>' +
        chartBarHtml(matByTrade, {showPlan: true}) + '</div>';
    }
    if (labByTrade.length) {
      html += '<div class="dash-section chart-panel"><p class="dash-title">Labour by trade</p>' +
        '<p class="panel-desc" style="margin:-6px 0 10px">Green = spent · faint = planned</p>' +
        chartBarHtml(labByTrade, {showPlan: true}) + '</div>';
    }
    html += '</div>';
  }

  const tableRows = state.budget.map(b => {
    const matP = budgetMaterialsPlanned(b), labP = budgetLabourPlanned(b);
    const matS = spentMaterialsForCat(b.category), labS = spentLabourForCat(b.category);
    const totalP = budgetPlan(b), rem = totalP - matS - labS;
    const matOver = (matP > 0 && matS > matP) || (matP <= 0 && matS > 0);
    const labOver = labP > 0 && labS > labP;
    return '<tr>' +
      '<td><strong>' + esc(b.category) + '</strong>' + (b.notes ? '<div class="entry-sub">' + esc(b.notes) + '</div>' : '') + '</td>' +
      '<td class="budget-cell' + (matOver ? ' over' : '') + '">' + budgetSpendCell(matS, matP) + '</td>' +
      '<td class="budget-cell' + (labOver ? ' over' : '') + '">' + budgetSpendCell(labS, labP) + '</td>' +
      '<td class="num tight">' + money(totalP) + '</td>' +
      '<td class="num tight' + (rem < 0 ? ' over' : '') + '">' + money(rem) + (rem < 0 ? ' <span class="over-badge">OVER</span>' : '') + '</td>' +
      '<td><div class="row-actions">' + actBtns('budget', b.id) + '</div></td></tr>';
  }).join('');

  html += '<div class="dash-section"><p class="dash-title">Trade template</p>' +
    '<p class="panel-desc" style="margin:-6px 0 10px">One row per trade. Materials or labour can be <strong>0</strong> if not needed. Tap + Add to create a row, or edit/delete here.</p>' +
    '<div class="purchase-table-wrap"><table class="purchase-table budget-table"><thead><tr>' +
    '<th>Trade</th><th>Materials</th><th>Labour</th><th class="num">Plan</th><th class="num">Remaining</th><th>Actions</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table></div></div>';
  return html;
}

function kindToggleHtml(source, id, kind) {
  const sid = esc(source);
  const iid = esc(id);
  return '<div class="kind-toggle" role="group" aria-label="Materials or labour">' +
    '<button type="button" class="kind-btn mat' + (kind === 'materials' ? ' on' : '') + '" data-kind-set="materials" data-source="' + sid + '" data-id="' + iid + '">Materials</button>' +
    '<button type="button" class="kind-btn lab' + (kind === 'labour' ? ' on' : '') + '" data-kind-set="labour" data-source="' + sid + '" data-id="' + iid + '">Labour</button></div>';
}

function chartBarHtml(rows, opts) {
  opts = opts || {};
  const max = Math.max(1, ...rows.map(r => Math.max(r.spent || r.amount || 0, r.planned || 0)));
  return rows.map(r => {
    const spent = r.spent ?? r.amount ?? 0;
    const planned = r.planned || 0;
    const sw = Math.min(100, spent / max * 100);
    const pw = planned ? Math.min(100, planned / max * 100) : 0;
    const over = planned > 0 && spent > planned;
    const label = r.trade || r.name || '—';
    return '<div class="chart-row">' +
      '<span class="chart-label" title="' + esc(label) + '">' + esc(label) + '</span>' +
      '<div class="chart-track">' +
      (opts.showPlan ? '<span class="chart-plan" style="width:' + pw + '%" title="Planned ' + money(planned) + '"></span>' : '') +
      '<span class="chart-spent' + (over ? ' over' : '') + '" style="width:' + sw + '%" title="Spent ' + money(spent) + '"></span></div>' +
      '<span class="chart-val">' + money(spent) + (planned ? '<em>/ ' + money(planned) + '</em>' : '') + '</span></div>';
  }).join('');
}

function paymentTableRow(p, opts) {
  opts = opts || {};
  const preview = p.source === 'labour' ? 'labour' : 'purchase';
  const thumb = p.thumb
    ? '<img src="' + esc(p.thumb) + '" class="thumb-sm" data-preview="' + preview + '" data-id="' + esc(p.id) + '" data-idx="0" alt="Proof">'
    : '';
  const editKind = p.source;
  return '<tr>' +
    '<td>' + esc(p.date || '—') + '</td>' +
    '<td><strong>' + esc(p.payee || '—') + '</strong></td>' +
    '<td class="item-cell">' + thumb + '<span>' + esc(p.label || '') + '</span></td>' +
    '<td>' + (p.category ? '<span class="chip cat">' + esc(p.category) + '</span>' : '—') + '</td>' +
    (opts.hideKind ? '' : ('<td class="kind-cell">' + kindToggleHtml(p.source, p.id, p.spendKind) + '</td>')) +
    '<td>' + esc(payMethodLabel(p.method)) + '</td>' +
    '<td class="num tight">' + money(p.amount) + '</td>' +
    (opts.hideActions ? '' : ('<td><div class="row-actions">' +
      '<button type="button" class="icon-btn icon-only" data-edit="' + editKind + '" data-id="' + p.id + '" title="Edit" aria-label="Edit">' + ICO.edit + '</button>' +
      '<button type="button" class="icon-btn icon-only danger" data-del="' + editKind + '" data-id="' + p.id + '" title="Delete" aria-label="Delete">' + ICO.trash + '</button></div></td>')) +
    '</tr>';
}

function renderLabour() {
  const rows = labourPayments();
  const spent = labourSpent();
  const planned = labourBudgetPlanned();
  const remain = planned - spent;
  const pct = planned > 0 ? Math.round(spent / planned * 100) : 0;

  let html = head('Labour payments', 'Contractor pay and anything you marked as labour on Paid. Charts compare spend to your labour budget per trade.', 'labour');

  html += '<div class="page-summary labour-summary">' +
    '<div class="insights-grid labour-stats">' +
    '<div class="insight-card"><p class="k">Labour spent</p><p class="v bad">' + money(spent) + '</p></div>' +
    '<div class="insight-card"><p class="k">Labour planned</p><p class="v">' + money(planned) + '</p></div>' +
    '<div class="insight-card"><p class="k">Remaining</p><p class="v ' + (remain < 0 ? 'bad' : 'good') + '">' + money(remain) + '</p></div>' +
    '<div class="insight-card"><p class="k">Budget used</p><p class="v ' + (pct > 100 ? 'bad' : '') + '">' + (planned ? pct + '%' : '—') + '</p></div>' +
    '</div>';

  if (planned > 0) {
    html += '<div class="chart-gauge"><div class="chart-gauge-bar"><span style="width:' + Math.min(100, pct) + '%" class="' + (pct > 100 ? 'over' : '') + '"></span></div>' +
      '<p class="chart-gauge-note">' + money(spent) + ' of ' + money(planned) + ' labour budget used' +
      (remain < 0 ? ' · <strong style="color:var(--spend)">Over by ' + money(-remain) + '</strong>' : '') + '</p></div>';
  }
  html += '</div>';

  const byTrade = labourByTrade();
  if (byTrade.length) {
    html += '<div class="dash-section chart-panel"><p class="dash-title">Labour by trade</p>' +
      '<p class="panel-desc" style="margin:-6px 0 10px">Green bar = spent · faint bar = planned</p>' +
      chartBarHtml(byTrade, {showPlan: true}) + '</div>';
  }

  const byPayee = labourByPayee().slice(0, 8);
  if (byPayee.length) {
    html += '<div class="dash-section chart-panel"><p class="dash-title">Top contractors paid</p>' +
      chartBarHtml(byPayee.map(r => ({name: r.name, amount: r.amount, spent: r.amount})), {showPlan: false}) + '</div>';
  }

  if (!rows.length) {
    html += empty('No labour payments yet', 'Add a contractor payment here, or mark a shop bill as Labour on the Paid tab.');
    return html;
  }

  html += '<div class="dash-section"><p class="dash-title">All labour payments</p>' +
    '<div class="purchase-table-wrap"><table class="purchase-table labour-table"><thead><tr>' +
    '<th>Date</th><th>Paid to</th><th>What</th><th>Trade</th><th>Method</th><th class="num">Amount</th><th>Actions</th>' +
    '</tr></thead><tbody>' +
    rows.map(p => paymentTableRow(p, {hideKind: true})).join('') +
    '</tbody></table></div></div>';
  return html;
}

function renderPaid() {
  const all = allPayments();
  const matTotal = materialsSpent();
  const labTotal = labourSpent();

  if (!all.length) {
    return '<div class="panel-head"><div><p class="panel-title">Paid to</p><p class="panel-desc">Every payment out — tick Materials or Labour so budgets stay correct.</p></div></div>' +
      empty('No payments yet', 'Log a purchase or a labour payment first.');
  }

  const q = paidSearch.toLowerCase();
  let filtered = all.filter(p => {
    if (paidKindFilter && p.spendKind !== paidKindFilter) return false;
    if (!q) return true;
    const blob = (p.payee + ' ' + p.label + ' ' + p.category + ' ' + p.notes).toLowerCase();
    return blob.includes(q);
  });

  const kindPills = [
    ['', 'All'],
    ['materials', 'Materials'],
    ['labour', 'Labour']
  ].map(([id, label]) =>
    '<button type="button" class="cat-pill' + (paidKindFilter === id ? ' on' : '') + '" data-paid-kind="' + id + '">' + label + '</button>'
  ).join('');

  const tableRows = filtered.map(p => paymentTableRow(p)).join('') ||
    '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--ink-2)">No matches</td></tr>';

  return '<div class="panel-head"><div><p class="panel-title">Paid to</p><p class="panel-desc">Who received the money — not the bank (MCB/Juice). Tap <strong>Materials</strong> or <strong>Labour</strong> to classify.</p></div></div>' +
    '<div class="insights-grid paid-stats">' +
    '<div class="insight-card"><p class="k">Total paid</p><p class="v">' + money(matTotal + labTotal) + '</p></div>' +
    '<div class="insight-card"><p class="k">Materials</p><p class="v">' + money(matTotal) + '</p></div>' +
    '<div class="insight-card"><p class="k">Labour</p><p class="v bad">' + money(labTotal) + '</p></div>' +
    '<div class="insight-card"><p class="k">Payments</p><p class="v">' + all.length + '</p></div></div>' +
    '<div class="purchase-toolbar">' +
    '<input class="paid-search" placeholder="Search payee or description…" value="' + esc(paidSearch) + '">' +
    '<div class="seller-cat-pills paid-kind-pills">' + kindPills + '</div></div>' +
    '<div class="purchase-table-wrap"><table class="purchase-table paid-table"><thead><tr>' +
    '<th>Date</th><th>Paid to</th><th>What</th><th>Trade</th><th>Kind</th><th>Method</th><th class="num">Amount</th><th>Actions</th>' +
    '</tr></thead><tbody>' + tableRows + '</tbody></table></div>';
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

function catalogThumbHtml(photos, item) {
  const ph = (photos || []).find(p => p && (p.thumb || p.driveFileId));
  if (!ph || !ph.thumb) return '';
  let attrs = ' class="thumb-sm" data-preview="catalog" alt="' + esc(item || 'Item') + '"';
  if (ph.driveFileId) attrs += ' data-drive-id="' + esc(ph.driveFileId) + '"';
  if (ph.webViewLink) attrs += ' data-drive-link="' + esc(ph.webViewLink) + '"';
  return '<img src="' + esc(ph.thumb) + '"' + attrs + '>';
}

function bookletHtml(photos, opts) {
  opts = opts || {};
  const list = (photos || []).filter(p => p && (p.thumb || p.driveFileId));
  if (!list.length) return '';
  const preview = opts.preview || 'catalog';
  return '<div class="booklet">' + list.map((ph, i) => {
    let attrs = ' data-preview="' + preview + '" data-idx="' + i + '"';
    if (preview === 'seller' && opts.recordId) attrs += ' data-id="' + esc(opts.recordId) + '"';
    if (ph.driveFileId) attrs += ' data-drive-id="' + esc(ph.driveFileId) + '"';
    if (ph.webViewLink) attrs += ' data-drive-link="' + esc(ph.webViewLink) + '"';
    const src = ph.thumb || '';
    if (!src) return '';
    return '<img src="' + esc(src) + '"' + attrs + ' alt="' + esc(opts.alt || 'Photo') + ' ' + (i + 1) + '">';
  }).join('') + '</div>';
}

function pagerHtml(page, pages, total) {
  if (pages <= 1) {
    return total ? '<div class="pager"><span class="pager-meta">' + total + ' item' + (total === 1 ? '' : 's') + '</span></div>' : '';
  }
  const btn = (n, label, on) => {
    const dis = n < 1 || n > pages;
    return '<button type="button" class="pager-btn' + (on ? ' on' : '') + '" data-page="' + n + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>';
  };
  let nums = '';
  let start = Math.max(1, page - 2);
  let end = Math.min(pages, start + 4);
  start = Math.max(1, end - 4);
  if (start > 1) nums += btn(1, '1', page === 1);
  if (start > 2) nums += '<span class="pager-gap">…</span>';
  for (let i = start; i <= end; i++) nums += btn(i, String(i), i === page);
  if (end < pages - 1) nums += '<span class="pager-gap">…</span>';
  if (end < pages) nums += btn(pages, String(pages), page === pages);
  return '<div class="pager">' +
    btn(page - 1, 'Prev', false) +
    nums +
    btn(page + 1, 'Next', false) +
    '<span class="pager-meta">' + total + ' item' + (total === 1 ? '' : 's') + '</span></div>';
}

function filteredCatalog() {
  return filterCatalog(catalogCache, sellerItemSearch, sellerCatFilter);
}

function catalogBodyHtml(slice) {
  if (!slice.length) {
    const msg = sellerItemSearch.trim() || sellerCatFilter
      ? 'No items match this search.'
      : 'No prices yet. Upload quote photos or log a purchase with line items.';
    return '<tr><td colspan="5" style="text-align:center;padding:18px;color:var(--ink-2)">' + msg + '</td></tr>';
  }
  return slice.map(r => '<tr class="clickable" data-catalog-id="' + esc(r.id) + '">' +
    '<td class="item-cell">' + catalogThumbHtml(r.photos, r.item) + '<span>' + esc(r.item) + '</span></td>' +
    '<td>' + (r.category ? '<span class="chip cat">' + esc(r.category) + '</span>' : '—') + '</td>' +
    '<td>' + esc(r.bestSeller || '—') + '</td>' +
    '<td class="num tight">' + (r.bestUnit ? moneyDec(r.bestUnit) : '—') + '</td>' +
    '<td>' + esc(r.date || '—') + '</td></tr>').join('');
}

function sellerCatPillsHtml(rows) {
  const present = new Set(catalogCategories(rows));
  const extra = [...present].filter(c => !CATEGORIES.includes(c));
  const pills = ['All'].concat(CATEGORIES).concat(extra);
  return '<div class="cat-pills seller-cat-pills">' + pills.map(c => {
    const val = c === 'All' ? '' : c;
    const on = sellerCatFilter === val;
    return '<button type="button" class="cat-pill' + (on ? ' on' : '') + '" data-cat="' + esc(val) + '">' + esc(c) + '</button>';
  }).join('') + '</div>';
}

function refreshSellerCatalog() {
  const filtered = filteredCatalog();
  const slice = catalogPage(filtered, sellerCatalogPage, CATALOG_PAGE_SIZE);
  sellerCatalogPage = slice.page;
  const tbody = $('seller-catalog-tbody');
  if (tbody) tbody.innerHTML = catalogBodyHtml(slice.rows);
  const pager = $('seller-catalog-pager');
  if (pager) pager.innerHTML = pagerHtml(slice.page, slice.pages, slice.total);
  bindSellerCatalogClicks();
}

function focusSellerSearch() {
  const el = document.querySelector('.seller-item-search');
  if (!el) return;
  const pos = el.value.length;
  el.focus();
  try { el.setSelectionRange(pos, pos); } catch (e) {}
}

function bindSellerCatalogClicks() {
  const root = $('panel-root');
  if (!root) return;
  root.querySelectorAll('tr.clickable[data-catalog-id]').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('[data-preview]')) return;
      const row = catalogCache.find(r => r.id === tr.dataset.catalogId);
      if (row) openCatalogItemModal(row);
    };
  });
  root.querySelectorAll('#seller-catalog-pager [data-page]').forEach(b => {
    b.onclick = () => {
      const n = Number(b.dataset.page);
      if (!n || b.disabled) return;
      sellerCatalogPage = n;
      refreshSellerCatalog();
    };
  });
}

function sellerCardHtml(s) {
  const photos = sellerPhotoList(s);
  return '<div class="entry seller-card"><div class="entry-top"><div><p class="entry-name">' + esc(s.name) + '</p>' +
    (s.contact ? '<p class="entry-sub">' + esc(s.contact) + '</p>' : '') + '</div>' + chip(s.status) + '</div>' +
    bookletHtml(photos, {preview: 'seller', recordId: s.id, alt: s.name || 'Seller photo'}) +
    '<div class="entry-meta">' + (s.item ? '<span class="meta-item">' + esc(s.item) + '</span>' : '') +
    ((s.price !== '' && s.price != null) ? '<span class="meta-item">Quoted <strong>' + money(s.price) + '</strong></span>' : '') +
    (s.notes ? '<span class="meta-item">' + esc(s.notes) + '</span>' : '') + '</div>' +
    '<div class="entry-actions">' + actBtns('sellers', s.id) + '</div></div>';
}

function renderSellers() {
  catalogCache = buildCatalog();
  const filtered = filteredCatalog();
  const slice = catalogPage(filtered, sellerCatalogPage, CATALOG_PAGE_SIZE);
  sellerCatalogPage = slice.page;
  const cards = state.sellers.map(sellerCardHtml).join('');
  return '<div class="panel-head"><div><p class="panel-title">Sellers shop</p>' +
    '<p class="panel-desc">Search quotes and receipts together. Upload a quote photo, or paste a list to see where to buy at the best price.</p></div></div>' +
    '<div class="shop-actions">' +
    '<button type="button" class="shop-action" data-shop="quote"><span class="k">Upload quote photos</span><span class="s">Camera or gallery — AI reads seller, contact, and line items.</span></button>' +
    '<button type="button" class="shop-action" data-shop="list"><span class="k">Build a shopping list</span><span class="s">Paste or upload items. We match known prices and group by seller.</span></button></div>' +
    '<div class="purchase-toolbar"><input class="seller-search-field seller-item-search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Search item, seller, category, contact…" value="' + esc(sellerItemSearch) + '"></div>' +
    sellerCatPillsHtml(catalogCache) +
    '<div class="purchase-table-wrap"><table class="purchase-table shop-table"><thead><tr>' +
    '<th>Item</th><th>Category</th><th>Best seller</th><th class="num">Best unit</th><th>Date</th></tr></thead>' +
    '<tbody id="seller-catalog-tbody">' + catalogBodyHtml(slice.rows) + '</tbody></table></div>' +
    '<div id="seller-catalog-pager">' + pagerHtml(slice.page, slice.pages, slice.total) + '</div>' +
    (state.sellers.length
      ? '<div class="dash-section seller-cards"><p class="dash-title">Your suppliers</p><div class="entry-list">' + cards + '</div></div>'
      : empty('No suppliers saved yet', 'Upload quote photos to add a shop, or keep using purchase receipts in the catalog above.'));
}

function overlayModal(opts) {
  session.editKind = opts.kind || null;
  session.editing = null;
  const modal = $('modal');
  const overlay = $('overlay');
  if (!modal || !overlay) return;
  modal.innerHTML =
    '<div class="modal-head"><p class="modal-title">' + opts.title + '</p>' +
    '<button class="modal-close" id="modal-close" aria-label="Close">&times;</button></div>' +
    (opts.sub ? '<p class="modal-sub">' + opts.sub + '</p>' : '') +
    '<div class="modal-body">' + opts.body + '</div>' +
    '<div class="modal-actions">' + (opts.actions || '<button class="btn-cancel" id="modal-cancel">Close</button>') + '</div>';
  overlay.classList.add('show');
  const closeBtn = $('modal-close'); if (closeBtn) closeBtn.onclick = closeModal;
  const cancelBtn = $('modal-cancel'); if (cancelBtn) cancelBtn.onclick = closeModal;
  if (typeof opts.bind === 'function') opts.bind();
}

function openCatalogItemModal(row) {
  const offers = (row.offers || []);
  const offerRows = offers.map((o, i) => '<tr' + (i === 0 ? ' class="detail-total"' : '') + '>' +
    '<td>' + esc(o.seller || '—') + (o.contact ? '<div class="entry-sub">' + esc(o.contact) + '</div>' : '') + '</td>' +
    '<td>' + (o.source === 'purchase' ? 'Receipt' : 'Quote') + '</td>' +
    '<td class="num">' + esc(o.qty || '') + '</td>' +
    '<td class="num tight">' + (o.unit ? moneyDec(o.unit) : '—') + '</td>' +
    '<td>' + esc(o.date || '—') + '</td></tr>').join('');
  overlayModal({
    kind: 'catalog-item',
    title: esc(row.item || 'Item'),
    sub: 'Best price and every shop that quoted or sold this item.',
    body:
      bookletHtml(row.photos, {preview: 'catalog', alt: row.item || 'Reference photo'}) +
      '<dl class="detail-grid">' +
      '<dt>Best seller</dt><dd>' + esc(row.bestSeller || '—') + (row.bestContact ? '<div class="entry-sub">' + esc(row.bestContact) + '</div>' : '') + '</dd>' +
      '<dt>Best unit</dt><dd class="tight">' + (row.bestUnit ? moneyDec(row.bestUnit) : '—') + '</dd>' +
      '<dt>Category</dt><dd>' + (row.category ? '<span class="chip cat">' + esc(row.category) + '</span>' : '—') + '</dd>' +
      '<dt>Date</dt><dd>' + esc(row.date || '—') + '</dd>' +
      '<dt>Samples</dt><dd>' + (row.samples || offers.length) + '</dd></dl>' +
      (offerRows ? '<table class="detail-lines"><thead><tr><th>Seller</th><th>Source</th><th class="num">Qty</th><th class="num">Unit</th><th>Date</th></tr></thead><tbody>' + offerRows + '</tbody></table>' : ''),
    actions: '<button class="btn-cancel" id="modal-cancel">Close</button>'
  });
}

function shopQuoteResultHtml(matches) {
  const grouped = groupQuoteBySeller(matches);
  let html = '';
  grouped.forEach((rows, seller) => {
    const unmatched = seller === 'Unmatched';
    html += '<div class="quote-group' + (unmatched ? ' unmatched' : '') + '"><p class="quote-seller">' +
      (unmatched ? 'Not found in catalog' : ('Buy at ' + esc(seller))) + '</p>';
    rows.forEach(m => {
      const best = m.match;
      const alts = (m.alts || []).filter(a => a.row && best && a.row.id !== best.id).slice(0, 3);
      html += '<div class="quote-line"><div><strong>' + esc(m.need.name) + '</strong>' +
        (m.need.qty ? '<span class="muted"> × ' + esc(m.need.qty) + '</span>' : '') + '</div>';
      if (best) {
        html += '<div class="quote-price">' + (best.bestUnit ? moneyDec(best.bestUnit) : '—') + '</div>';
        if (alts.length) {
          html += '<p class="quote-alts">Also ' + alts.map(a => esc(a.row.bestSeller || 'other') + ' ' + (a.row.bestUnit ? moneyDec(a.row.bestUnit) : '')).join(' · ') + '</p>';
        }
      } else {
        html += '<p class="quote-alts">No matching price yet. Upload a quote or receipt for this item.</p>';
      }
      html += '</div>';
    });
    html += '</div>';
  });
  return html || '<p class="field-hint">No items to match.</p>';
}

async function buildShopQuotation() {
  const ta = $('shop-list-text');
  shopListDraft = ta ? ta.value : shopListDraft;
  const needs = parseShoppingList(shopListDraft);
  const status = $('shop-list-status');
  const out = $('shop-list-result');
  if (!needs.length) {
    if (status) status.textContent = 'Paste at least one item name, one per line.';
    if (out) out.innerHTML = '';
    return;
  }
  if (status) status.textContent = 'Matching ' + needs.length + ' item' + (needs.length === 1 ? '' : 's') + '…';
  const catalog = catalogCache.length ? catalogCache : buildCatalog();
  let matches = matchShoppingList(needs, catalog);
  const missing = matches.filter(m => !m.match).map(m => m.need.name);
  if (missing.length && settings.apiKey) {
    if (status) status.textContent = 'Matching leftover names with AI…';
    const hints = await aiAssistMatches(missing, catalog.map(r => r.item));
    matches = applyAiMatches(matches, hints, catalog);
  }
  const hit = matches.filter(m => m.match).length;
  if (status) status.textContent = 'Matched ' + hit + ' of ' + needs.length + '. Grouped by where to buy.';
  if (out) out.innerHTML = shopQuoteResultHtml(matches);
}

function openShoppingListModal() {
  overlayModal({
    kind: 'shop-list',
    title: 'Shopping list / quotation',
    sub: 'Paste item names (one per line) or upload a .txt / .csv. We match against seller quotes and purchase receipts.',
    body:
      '<div class="field wide"><label>Items you need</label>' +
      '<textarea id="shop-list-text" class="shop-list-text" rows="7" placeholder="Termicide&#10;PVC 25mm elbow&#10;electrical tape">' + esc(shopListDraft) + '</textarea></div>' +
      '<label class="photo-btn" style="margin-top:10px">Upload .txt or .csv' +
      '<input type="file" accept=".txt,.csv,text/plain,text/csv" id="shop-list-file" style="display:none"></label>' +
      '<p class="field-hint" id="shop-list-status">Works without AI. If an API key is saved, leftover messy names can be matched too.</p>' +
      '<div id="shop-list-result" class="shop-list-result"></div>',
    actions: '<button class="btn-primary" id="shop-build">Build quotation</button><button class="btn-cancel" id="modal-cancel">Close</button>',
    bind: () => {
      const build = $('shop-build');
      if (build) build.onclick = () => buildShopQuotation();
      const file = $('shop-list-file');
      if (file) file.onchange = e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          const ta = $('shop-list-text');
          if (ta) ta.value = String(reader.result || '');
          shopListDraft = ta ? ta.value : '';
        };
        reader.readAsText(f);
      };
      const ta = $('shop-list-text');
      if (ta) {
        ta.addEventListener('input', () => { shopListDraft = ta.value; });
        setTimeout(() => ta.focus(), 40);
      }
    }
  });
}
let purchaseSort = {col: 'date', asc: false};
let purchaseSearch = '';
let purchaseCatFilter = '';
let purchaseExpandedId = null;

function renderPurchases() {
  if (!state.purchases.length) {
    return head('Purchases &amp; receipts', 'Shop bills: cash receipt, Juice screenshot, or MCB card. AI fills items. Hits the materials envelope.', 'purchases') +
      empty('No purchases logged yet', 'Take a photo or pick from the gallery. Mark cash, card, or Juice, then Save.');
  }

  const cats = [...new Set(state.purchases.flatMap(p => purchaseCategories(p)))].sort();
  const catOpts = '<option value="">All categories</option>' + cats.map(c => '<option value="' + esc(c) + '"' + (purchaseCatFilter === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('');

  const q = purchaseSearch.toLowerCase();
  let filtered = state.purchases.filter(p => {
    const pcats = purchaseCategories(p);
    if (purchaseCatFilter && !pcats.includes(purchaseCatFilter) && (p.category || '') !== purchaseCatFilter) return false;
    const blob = ((p.item || '') + ' ' + (p.seller || '') + ' ' + pcats.join(' ') + ' ' + (p.receipt || '') + ' ' + (p.notes || '') + ' ' + payMethodLabel(p.paymentMethod)).toLowerCase();
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
  const cols = [['date','Date'],['item','Item'],['seller','Seller'],['category','Category'],['price','Total'],['paymentMethod','Paid by'],['receipt','Receipt #']];

  let rows = '';
  filtered.forEach(p => {
    const displayPrice = purchaseTotal(p);
    rows += '<tr class="clickable" data-row-id="' + p.id + '">' +
      '<td>' + esc(p.date || '') + '</td>' +
      '<td class="item-cell">' + (p.thumb ? '<img src="' + p.thumb + '" class="thumb-sm" data-preview="purchase" data-id="' + p.id + '" alt="Receipt">' : '') + '<span>' + esc(p.item || '') + '</span></td>' +
      '<td>' + esc(p.seller || '') + '</td>' +
      '<td>' + catChips(p) + '</td>' +
      '<td class="num tight">' + money(displayPrice) + '</td>' +
      '<td>' + esc(payMethodLabel(p.paymentMethod)) + '</td>' +
      '<td>' + esc(p.receipt || '') + '</td>' +
      '<td>' + actBtns('purchases', p.id) + '</td></tr>';

    if (purchaseExpandedId === p.id) {
      rows += '<tr class="purchase-detail"><td colspan="8">' + renderPurchaseDetail(p) + '</td></tr>';
    }
  });

  return head('Purchases &amp; receipts', 'Shop bills: cash receipt, Juice screenshot, or MCB card. AI fills items. Hits the materials envelope.', 'purchases') +
    '<div class="purchase-toolbar">' +
    '<input class="purchase-search" placeholder="Search purchases\u2026" value="' + esc(purchaseSearch) + '">' +
    '<select class="purchase-cat-filter">' + catOpts + '</select></div>' +
    '<div class="purchase-table-wrap"><table class="purchase-table"><thead><tr>' +
    cols.map(([k, l]) => '<th data-sort="' + k + '"' + thCls(k) + '>' + l + arrow(k) + '</th>').join('') +
    '<th>Actions</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--ink-2)">No matches</td></tr>') + '</tbody></table></div>';
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
  if (p.paymentMethod) html += '<dt>Paid by</dt><dd>' + esc(payMethodLabel(p.paymentMethod)) + '</dd>';
  if (p.notes) html += '<dt>Notes</dt><dd>' + esc(p.notes) + '</dd>';
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
  const renderer = {dashboard: renderDashboard, funds: renderFunds, budget: renderBudget, actions: renderActions, sellers: renderSellers, purchases: renderPurchases, labour: renderLabour, paid: renderPaid}[session.activeTab];
  root.innerHTML = renderer ? renderer() : renderDashboard();
  refreshTradeDatalist();
  attach();
  updateSyncPill();
  const fab = $('fab-add');
  if (fab) fab.style.display = session.activeTab === 'paid' ? 'none' : '';
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
  root.querySelectorAll('[data-shop]').forEach(b => b.onclick = () => {
    if (b.dataset.shop === 'quote') openModal('sellers', null);
    else if (b.dataset.shop === 'list') openShoppingListModal();
  });
  root.querySelectorAll('.seller-cat-pills [data-cat]').forEach(b => {
    b.onclick = () => {
      sellerCatFilter = b.dataset.cat || '';
      sellerCatalogPage = 1;
      root.querySelectorAll('.seller-cat-pills [data-cat]').forEach(x => x.classList.toggle('on', (x.dataset.cat || '') === sellerCatFilter));
      refreshSellerCatalog();
    };
  });
  const sellerSearchEl = root.querySelector('.seller-item-search');
  if (sellerSearchEl) {
    sellerSearchEl.oninput = e => {
      sellerItemSearch = e.target.value;
      sellerCatalogPage = 1;
      refreshSellerCatalog();
    };
    if (sellerItemSearch) focusSellerSearch();
  }
  bindSellerCatalogClicks();
  bindKindToggles(root, true);
  root.querySelectorAll('.paid-kind-pills [data-paid-kind]').forEach(b => {
    b.onclick = () => { paidKindFilter = b.dataset.paidKind || ''; render(); };
  });
  const paidSearchEl = root.querySelector('.paid-search');
  if (paidSearchEl) {
    paidSearchEl.oninput = e => { paidSearch = e.target.value; render(); };
    if (session.activeTab === 'paid' && paidSearch) {
      const pos = paidSearchEl.value.length;
      paidSearchEl.focus();
      paidSearchEl.setSelectionRange(pos, pos);
    }
  }
  const searchEl = session.activeTab === 'purchases' ? root.querySelector('.purchase-search') : null;
  if (searchEl) {
    searchEl.oninput = e => { purchaseSearch = e.target.value; render(); };
    if (purchaseSearch) {
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
    p = p || {category: '', budgeted: '', budgetedMaterials: '', budgetedLabour: '', notes: ''};
    let matVal = '';
    if (p.budgetedMaterials != null && p.budgetedMaterials !== '') matVal = p.budgetedMaterials;
    else if (p.budgeted != null && p.budgeted !== '') matVal = p.budgeted;
    const labVal = (p.budgetedLabour != null && p.budgetedLabour !== '') ? p.budgetedLabour : '';
    return '<div class="form-grid">' +
      '<div class="field wide"><label class="req">Trade</label><input list="category-options" id="m-category" value="' + esc(p.category) + '" placeholder="Type or pick — add new names anytime"></div>' +
      '<div class="field"><label>Materials (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-budgeted-mat" value="' + esc(matVal) + '" placeholder="0 if labour only"></div>' +
      '<div class="field"><label>Labour (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-budgeted-lab" value="' + esc(labVal) + '" placeholder="0 if materials only"></div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes) + '" placeholder="e.g. Jerome"></div></div>';
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
      accept: 'image/*,application/pdf',
      hint: 'Cash receipt, Juice screenshot/PDF, or card transaction. For multi-page bills, add all photos first. AI reads every page into one table.',
      ocrLabel: hasKey ? 'Re-scan with AI' : 'Scan receipt',
      extraHtml: hasKey ? '' : inlineAiHtml()
    }) +
      '<div class="receipt-meta">' +
      '<div class="field"><label class="req">Paid to</label><input id="m-payee" value="' + esc(p.payee || purchasePayee(p) || p.seller || '') + '" placeholder="Who received the money" autocomplete="off"></div>' +
      '<div class="field"><label>Receipt from</label><input id="m-seller" value="' + esc(p.seller || '') + '" placeholder="Shop on receipt (optional)" autocomplete="off"></div>' +
      '<div class="field"><label>Date</label><input type="date" id="m-date" value="' + esc(p.date || todayStr()) + '"></div>' +
      '<div class="field"><label>Receipt no.</label><input id="m-receipt" value="' + esc(p.receipt) + '" placeholder="Optional"></div>' +
      '<div class="field"><label>Paid via</label>' + methodSelectHtml('m-method', p.paymentMethod || (isBankName(p.seller) ? 'juice' : '')) + '</div></div>' +
      '<div class="field wide"><label>Categories</label>' +
      categoryPillsHtml(purchaseCategories(p)) +
      '<p class="field-hint">Tap all that apply. AI also tags each line — change a line if it guessed wrong.</p>' +
      '<button type="button" class="ocr-btn" id="m-fill-ai" style="margin-top:8px">Fill missing with AI</button>' +
      '<p class="field-hint" id="m-fill-status"></p></div>' +
      '<p class="field-hint receipt-table-label">Line items — AI fills this; tap a cell to correct.</p>' +
      purchaseLinesHtml(lines) +
      '<div class="receipt-total-row">' +
      '<div class="field"><label class="req">Total (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-price" value="' + esc(p.price) + '" placeholder="Grand total"></div>' +
      '<div class="field"><label class="req">Summary</label><input id="m-item" value="' + esc(p.item) + '" placeholder="AI writes a short label" autocomplete="off"></div></div>' +
      '<div class="field wide" style="margin-top:12px"><label>Notes</label><input id="m-notes" value="' + esc(p.notes || '') + '" placeholder="Optional"></div>' +
      '<div class="field wide"><label>Counts as</label>' + kindToggleHtml('purchases', p.id || 'new', defaultSpendKind(p, 'purchases')) + '</div>';
  }
  if (kind === 'labour') {
    p = p || {payee: '', category: '', amount: '', date: todayStr(), method: 'cash', notes: '', photos: []};
    const photos = existingFormPhotos(p, 'labour');
    return photoFieldHtml({
      photos, hasKey: false, skipOcr: true,
      kind: 'labour', recordId: p.id || '', alt: 'Proof',
      accept: 'image/*,application/pdf',
      hint: 'Cash receipt, Juice screenshot/PDF, or MCB card transaction. No AI scan — just attach proof.'
    }) +
      '<div class="form-grid">' +
      '<div class="field"><label class="req">Paid to</label><input id="m-payee" value="' + esc(p.payee) + '" placeholder="Plumber, electrician…" autocomplete="off"></div>' +
      '<div class="field"><label class="req">Trade</label><input list="category-options" id="m-category" value="' + esc(p.category) + '" placeholder="Plumbing, Electrical…"></div>' +
      '<div class="field"><label class="req">Amount (Rs)</label><input type="number" inputmode="decimal" min="0" step="any" id="m-amount" value="' + esc(p.amount) + '" placeholder="e.g. 15000"></div>' +
      '<div class="field"><label>Date</label><input type="date" id="m-date" value="' + esc(p.date || todayStr()) + '"></div>' +
      '<div class="field"><label>Paid by</label>' + methodSelectHtml('m-method', p.method || 'cash') + '</div>' +
      '<div class="field wide"><label>Notes</label><input id="m-notes" value="' + esc(p.notes || '') + '" placeholder="Optional"></div>' +
      '<div class="field wide"><label>Counts as</label>' + kindToggleHtml('labour', p.id || 'new', defaultSpendKind(p, 'labour')) + '</div></div>';
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
    budget: 'Plan materials and labour for this trade. Shop bills deduct materials; contractor payments deduct labour.',
    actions: 'One thing still to do. Due date is optional.',
    sellers: 'Snap or pick quote photos. Each photo can be a different shop — AI fills name, contact, and lines.',
    purchases: 'Shop bill: cash receipt, Juice screenshot, or MCB card. AI fills items. Hits the materials envelope.',
    labour: 'Contractor pay: who, trade, amount, cash/card/Juice, and a photo of the proof.'
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
    const el = $('m-amount') || $('m-payee') || $('m-title') || $('m-name') || $('m-category');
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
  bindAlbumControls(modal, (session.editKind === 'purchases' || session.editKind === 'sellers') ? maybeScanAfterPhoto : null);
  const ocr = $('m-ocr'); if (ocr) ocr.onclick = startReceiptScan;
  wireModelPicker('m-ai', 'm-ai-custom');
  bindLineTable();
  bindKindToggles(modal, false);
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
    seller: l.seller || g.name, contact: l.contact || g.contact,
    category: l.category || guessCategoryFromItem(l.item) || ''
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

function readSpendKindFromForm(fallback) {
  const on = document.querySelector('.kind-toggle .kind-btn.on[data-kind-set]');
  if (on) return on.dataset.kindSet;
  return fallback || 'materials';
}

function bindKindToggles(root, persistOnChange) {
  if (!root) return;
  root.querySelectorAll('.kind-toggle [data-kind-set]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const kind = btn.dataset.kindSet;
      const group = btn.closest('.kind-toggle');
      if (group) {
        group.querySelectorAll('[data-kind-set]').forEach(b => b.classList.toggle('on', b === btn));
      }
      if (!persistOnChange) return;
      const source = btn.dataset.source;
      const id = btn.dataset.id;
      if (!source || !id || id === 'new') return;
      const rec = (state[source] || []).find(x => x.id === id);
      if (!rec) return;
      rec.spendKind = kind;
      rec.updatedAt = new Date().toISOString();
      await persist(source);
      render();
      if (settings.driveToken) scheduleCsvSync();
    };
  });
}

async function saveModal() {
  if (saveBusy) return;
  const k = session.editKind, val = id => { const el = $(id); return el ? el.value : ''; };
  if (k === 'catalog-item' || k === 'shop-list') return;
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
    const c = val('m-category').trim();
    const matRaw = val('m-budgeted-mat');
    const labRaw = val('m-budgeted-lab');
    if (!c) return showErr('Enter a trade name (Plumbing, Foundation, or your own).');
    if (matRaw !== '' && (!finiteNum(matRaw) || +matRaw < 0)) return showErr('Materials must be 0 or more, or leave blank.');
    if (labRaw !== '' && (!finiteNum(labRaw) || +labRaw < 0)) return showErr('Labour must be 0 or more, or leave blank.');
    const materials = matRaw === '' ? 0 : +matRaw;
    const labourAmt = labRaw === '' ? 0 : +labRaw;
    obj = {category: c, budgetedMaterials: materials, budgetedLabour: labourAmt, budgeted: materials + labourAmt, notes: val('m-notes').trim()};
    registerTradeCategory(c);
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
      payee: val('m-payee').trim() || form.payee || form.seller,
      price: +form.price,
      date: form.date || todayStr(),
      receipt: form.receipt,
      paymentMethod: val('m-method') || 'cash',
      spendKind: readSpendKindFromForm('materials'),
      notes: val('m-notes').trim(),
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
  } else if (k === 'labour') {
    const payee = val('m-payee').trim();
    const cat = val('m-category').trim();
    const amt = val('m-amount');
    if (!payee) return showErr('Enter who you paid.');
    if (!cat) return showErr('Enter the trade (Plumbing, Electrical…).');
    if (!finiteNum(amt) || +amt < 0) return showErr('Enter a valid amount.');
    if (!state.labour) state.labour = [];
    obj = {
      payee,
      category: cat,
      amount: +amt,
      date: val('m-date') || todayStr(),
      method: val('m-method') || 'cash',
      spendKind: readSpendKindFromForm('labour'),
      notes: val('m-notes').trim()
    };
    const pending = pendingPhotos();
    if (pending.length) {
      const links = [];
      if (settings.driveToken) {
        try {
          for (const ph of pending) {
            const up = await uploadOriginalToDrive(ph.originalFile, {
              item: payee, category: cat, seller: payee, date: obj.date, receipt: 'labour', ext: ph.ext
            });
            if (up) links.push({id: up.id, webViewLink: up.webViewLink, folderPath: up.folderPath || ''});
          }
        } catch (e) {
          return showErr('Could not upload proof to Drive. Enable Drive API if needed, then tap Save again. The photos are still attached.');
        }
      } else {
        toast('Saved on this device. Sign in to keep the original photos in Drive.');
      }
      obj.photoLinks = links;
      obj.photos = pending.map((ph, i) => persistablePhoto(ph, links[i]));
      obj.thumb = (pending[0] && (pending[0].thumbDataUrl || pending[0].thumb)) || '';
      if (links[0]) {
        obj.driveLink = links[0].webViewLink;
        obj.driveFileId = links[0].id;
      }
    } else if (session.photoCleared) {
      obj.photos = []; obj.photoLinks = []; obj.thumb = ''; obj.driveLink = null; obj.driveFileId = null;
    } else if (editing) {
      obj.photos = Array.isArray(editing.photos) ? editing.photos.slice() : [];
      obj.photoLinks = Array.isArray(editing.photoLinks) ? editing.photoLinks.slice() : [];
      obj.thumb = editing.thumb || '';
      obj.driveLink = editing.driveLink;
      obj.driveFileId = editing.driveFileId;
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
    '<div class="set-section"><h3>Trade categories</h3><p class="hint">Names for Budget, Purchases, and Labour. Built-in defaults plus any you add. Budget rows also appear here.</p>' +
    '<div class="trade-cat-list" id="trade-cat-list"></div>' +
    '<div class="set-row" style="margin-top:10px">' +
    '<input id="set-trade-new" class="trade-cat-input" placeholder="New trade name" autocomplete="off">' +
    '<button type="button" class="set-btn" id="set-trade-add">Add trade</button></div></div>' +
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
  renderTradeCatList();
  const tradeAdd = $('set-trade-add');
  const tradeNew = $('set-trade-new');
  if (tradeAdd && tradeNew) {
    tradeAdd.onclick = async () => {
      const c = tradeNew.value.trim();
      if (!c) { toast('Enter a trade name'); return; }
      registerTradeCategory(c);
      tradeNew.value = '';
      renderTradeCatList();
      refreshTradeDatalist();
      toast('Added “' + c + '”');
    };
    tradeNew.onkeydown = e => { if (e.key === 'Enter') tradeAdd.click(); };
  }
}

function renderTradeCatList() {
  const box = $('trade-cat-list');
  if (!box) return;
  const cats = allTradeCategories();
  if (!cats.length) {
    box.innerHTML = '<p class="field-hint">No trades yet.</p>';
    return;
  }
  box.innerHTML = cats.map(c => {
    const custom = (settings.tradeCategories || []).includes(c) && !CATEGORIES.includes(c);
    const inBudget = (state.budget || []).some(b => b.category === c);
    return '<div class="trade-cat-row"><span>' + esc(c) +
      (custom ? ' <em class="tag">custom</em>' : '') +
      (inBudget ? ' <em class="tag">budget</em>' : '') + '</span>' +
      (custom ? '<button type="button" class="icon-btn danger icon-only" data-trade-del="' + esc(c) + '" title="Remove">×</button>' : '') +
      '</div>';
  }).join('');
  box.querySelectorAll('[data-trade-del]').forEach(btn => {
    btn.onclick = async () => {
      const c = btn.dataset.tradeDel;
      if (!c || !confirm('Remove custom trade “' + c + '” from the list? Budget rows are not deleted.')) return;
      settings.tradeCategories = (settings.tradeCategories || []).filter(x => x !== c);
      await saveSettings();
      renderTradeCatList();
      refreshTradeDatalist();
    };
  });
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
    const k = session.activeTab === 'dashboard' ? 'purchases' : (session.activeTab === 'paid' ? 'labour' : session.activeTab);
    if (TITLES[k]) openModal(k, null);
  };
  watchChrome();
}

hub.render = render;
hub.updateSyncPill = updateSyncPill;
