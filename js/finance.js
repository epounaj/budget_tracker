/** Plan vs spend: purchases are materials, contractor records are labour. */
import {state} from './store.js?v=20260818x';
import {normalizeCategory, lineAmount, sumLines, purchaseCategories} from './util.js?v=20260818x';

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

export function loanReceived() {
  return (state.funds || []).filter(f => f.type === 'loan').reduce((s, f) => s + (+f.amount || 0), 0);
}
export function ownCash() {
  return (state.funds || []).filter(f => f.type === 'cash').reduce((s, f) => s + (+f.amount || 0), 0);
}
export function fundsIn() { return loanReceived() + ownCash(); }

export function materialsSpent() {
  return (state.purchases || []).reduce((s, p) => s + purchaseTotal(p), 0);
}
export function labourSpent() {
  return (state.labour || []).reduce((s, p) => s + labourTotal(p), 0);
}
export function totalSpent() { return materialsSpent() + labourSpent(); }
export function inHand() { return fundsIn() - totalSpent(); }

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

export function spentMaterialsForCat(c) {
  const key = String(c || '').toLowerCase();
  return (state.purchases || []).reduce((s, p) => {
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const tagged = lines.filter(l => normalizeCategory(l.category));
    if (tagged.length) {
      return s + tagged.filter(l => normalizeCategory(l.category).toLowerCase() === key)
        .reduce((a, l) => a + lineAmount(l), 0);
    }
    const cats = purchaseCategories(p);
    if (!cats.length) return s;
    if (cats.length === 1 && cats[0].toLowerCase() === key) return s + purchaseTotal(p);
    if (cats.some(x => x.toLowerCase() === key)) return s + purchaseTotal(p) / cats.length;
    return s;
  }, 0);
}

export function spentLabourForCat(c) {
  const key = String(c || '').toLowerCase();
  return (state.labour || []).reduce((s, p) => {
    const cat = normalizeCategory(p.category || '').toLowerCase();
    if (cat === key) return s + labourTotal(p);
    return s;
  }, 0);
}

export function payeeKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function labourThumb(row) {
  if (row.thumb) return row.thumb;
  const ph = Array.isArray(row.photos) && row.photos[0];
  return (ph && (ph.thumb || ph.thumbDataUrl)) || '';
}

export function paidToRows() {
  const map = new Map();
  const add = (name, kind, amount, rec) => {
    const key = payeeKey(name);
    if (!key || !amount) return;
    if (!map.has(key)) {
      map.set(key, {key, name: String(name || '').trim(), materials: 0, labour: 0, total: 0, last: '', items: []});
    }
    const row = map.get(key);
    if (kind === 'labour') row.labour += amount;
    else row.materials += amount;
    row.total = row.materials + row.labour;
    if ((rec.date || '') > (row.last || '')) row.last = rec.date || '';
    row.items.push(rec);
  };
  (state.purchases || []).forEach(p => add(p.seller, 'materials', purchaseTotal(p), {
    id: p.id,
    date: p.date || '',
    method: p.paymentMethod || '',
    category: (purchaseCategories(p)[0] || p.category || ''),
    notes: p.notes || '',
    thumb: p.thumb || '',
    driveLink: p.driveLink || '',
    source: 'purchases',
    kind: 'materials',
    amount: purchaseTotal(p),
    label: p.item || 'Shop bill'
  }));
  (state.labour || []).forEach(p => add(p.payee, 'labour', labourTotal(p), {
    id: p.id,
    date: p.date || '',
    method: p.method || '',
    category: p.category || '',
    notes: p.notes || '',
    thumb: labourThumb(p),
    photos: p.photos,
    photoLinks: p.photoLinks,
    driveLink: p.driveLink || (Array.isArray(p.photoLinks) && p.photoLinks[0] && p.photoLinks[0].webViewLink) || '',
    source: 'labour',
    kind: 'labour',
    amount: labourTotal(p),
    label: p.notes || (p.category ? (p.category + ' labour') : 'Labour')
  }));
  map.forEach(row => {
    row.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  });
  return [...map.values()].sort((a, b) => b.total - a.total);
}
