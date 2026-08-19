/** Plan vs spend: each payment is materials or labour (user can override on Paid tab). */
import {state} from './store.js?v=20260819b';
import {normalizeCategory, lineAmount, sumLines, purchaseCategories} from './util.js?v=20260819b';

export const PAY_METHODS = [
  {id: 'cash', label: 'Cash'},
  {id: 'card', label: 'Card (MCB)'},
  {id: 'juice', label: 'Juice (MCB)'}
];

export function payMethodLabel(id) {
  const m = PAY_METHODS.find(x => x.id === id);
  return m ? m.label : (id ? String(id) : '—');
}

export function purchaseTotal(p) {
  const ls = sumLines(p && p.lines);
  return ls || +p.price || 0;
}

export function labourTotal(row) { return +(row && row.amount) || 0; }

export function defaultSpendKind(rec, source) {
  if (rec && (rec.spendKind === 'labour' || rec.spendKind === 'materials')) return rec.spendKind;
  return source === 'labour' ? 'labour' : 'materials';
}

function labourThumb(row) {
  if (row.thumb) return row.thumb;
  const ph = Array.isArray(row.photos) && row.photos[0];
  return (ph && (ph.thumb || ph.thumbDataUrl)) || '';
}

/** Every money-out row, flat, with effective spendKind. */
export function allPayments() {
  const out = [];
  (state.purchases || []).forEach(p => {
    const amount = purchaseTotal(p);
    if (!amount) return;
    out.push({
      id: p.id,
      source: 'purchases',
      payee: String(p.seller || '').trim(),
      label: p.item || 'Shop bill',
      category: (purchaseCategories(p)[0] || p.category || ''),
      date: p.date || '',
      method: p.paymentMethod || '',
      amount,
      spendKind: defaultSpendKind(p, 'purchases'),
      thumb: p.thumb || '',
      notes: p.notes || '',
      driveLink: p.driveLink || ''
    });
  });
  (state.labour || []).forEach(p => {
    const amount = labourTotal(p);
    if (!amount) return;
    out.push({
      id: p.id,
      source: 'labour',
      payee: String(p.payee || '').trim(),
      label: p.notes || (p.category ? (p.category + ' labour') : 'Labour'),
      category: p.category || '',
      date: p.date || '',
      method: p.method || '',
      amount,
      spendKind: defaultSpendKind(p, 'labour'),
      thumb: labourThumb(p),
      notes: p.notes || '',
      driveLink: p.driveLink || (Array.isArray(p.photoLinks) && p.photoLinks[0] && p.photoLinks[0].webViewLink) || ''
    });
  });
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export function labourPayments() {
  return allPayments().filter(p => p.spendKind === 'labour');
}

export function materialsPayments() {
  return allPayments().filter(p => p.spendKind === 'materials');
}

export function loanReceived() {
  return (state.funds || []).filter(f => f.type === 'loan').reduce((s, f) => s + (+f.amount || 0), 0);
}
export function ownCash() {
  return (state.funds || []).filter(f => f.type === 'cash').reduce((s, f) => s + (+f.amount || 0), 0);
}
export function fundsIn() { return loanReceived() + ownCash(); }

export function materialsSpent() {
  return materialsPayments().reduce((s, p) => s + p.amount, 0);
}
export function labourSpent() {
  return labourPayments().reduce((s, p) => s + p.amount, 0);
}
export function totalSpent() { return materialsSpent() + labourSpent(); }
export function inHand() { return fundsIn() - totalSpent(); }

export function labourBudgetPlanned() {
  return (state.budget || []).reduce((s, b) => s + budgetLabourPlanned(b), 0);
}

export function budgetMaterialsPlanned(b) {
  if (b && b.budgetedMaterials != null && b.budgetedMaterials !== '') return +b.budgetedMaterials || 0;
  return +(b && b.budgeted) || 0;
}
export function budgetLabourPlanned(b) { return +(b && b.budgetedLabour) || 0; }
export function budgetPlan(b) { return budgetMaterialsPlanned(b) + budgetLabourPlanned(b); }
export function totalPlan() {
  return (state.budget || []).reduce((s, b) => s + budgetPlan(b), 0);
}
export function extraNeeded() { return Math.max(0, totalPlan() - fundsIn()); }
export function overdrawn() { return Math.max(0, totalSpent() - fundsIn()); }

function purchaseMaterialsForCat(p, key) {
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const tagged = lines.filter(l => normalizeCategory(l.category));
  if (tagged.length) {
    return tagged.filter(l => normalizeCategory(l.category).toLowerCase() === key)
      .reduce((a, l) => a + lineAmount(l), 0);
  }
  const cats = purchaseCategories(p);
  if (!cats.length) return 0;
  if (cats.length === 1 && cats[0].toLowerCase() === key) return purchaseTotal(p);
  if (cats.some(x => x.toLowerCase() === key)) return purchaseTotal(p) / cats.length;
  return 0;
}

export function spentMaterialsForCat(c) {
  const key = String(c || '').toLowerCase();
  let total = 0;
  (state.purchases || []).forEach(p => {
    if (defaultSpendKind(p, 'purchases') !== 'materials') return;
    total += purchaseMaterialsForCat(p, key);
  });
  (state.labour || []).forEach(p => {
    if (defaultSpendKind(p, 'labour') !== 'materials') return;
    if (normalizeCategory(p.category || '').toLowerCase() === key) total += labourTotal(p);
  });
  return total;
}

export function spentLabourForCat(c) {
  const key = String(c || '').toLowerCase();
  let total = 0;
  (state.purchases || []).forEach(p => {
    if (defaultSpendKind(p, 'purchases') !== 'labour') return;
    total += purchaseMaterialsForCat(p, key) || purchaseTotal(p);
  });
  (state.labour || []).forEach(p => {
    if (defaultSpendKind(p, 'labour') !== 'labour') return;
    if (normalizeCategory(p.category || '').toLowerCase() === key) total += labourTotal(p);
  });
  return total;
}

/** Planned vs spent labour per trade — for charts on Labour tab. */
export function labourByTrade() {
  const map = new Map();
  labourPayments().forEach(p => {
    const trade = p.category || 'Uncategorized';
    map.set(trade, (map.get(trade) || 0) + p.amount);
  });
  (state.budget || []).forEach(b => {
    const planned = budgetLabourPlanned(b);
    if (planned > 0 || map.has(b.category)) {
      if (!map.has(b.category)) map.set(b.category, 0);
    }
  });
  return [...map.entries()].map(([trade, spent]) => {
    const bud = (state.budget || []).find(b => b.category === trade);
    return {trade, spent, planned: bud ? budgetLabourPlanned(bud) : 0};
  }).sort((a, b) => b.spent - a.spent);
}

/** Labour spend grouped by payee — for charts. */
export function labourByPayee() {
  const map = new Map();
  labourPayments().forEach(p => {
    const name = p.payee || 'Unknown';
    map.set(name, (map.get(name) || 0) + p.amount);
  });
  return [...map.entries()].map(([name, amount]) => ({name, amount}))
    .sort((a, b) => b.amount - a.amount);
}

export function payeeKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function paidToRows() {
  const map = new Map();
  allPayments().forEach(p => {
    const key = payeeKey(p.payee);
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {key, name: p.payee, materials: 0, labour: 0, total: 0, last: '', items: []});
    }
    const row = map.get(key);
    if (p.spendKind === 'labour') row.labour += p.amount;
    else row.materials += p.amount;
    row.total = row.materials + row.labour;
    if ((p.date || '') > (row.last || '')) row.last = p.date || '';
    row.items.push(Object.assign({}, p, {kind: p.spendKind, source: p.source}));
  });
  map.forEach(row => {
    row.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}
