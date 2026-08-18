import {uid} from './util.js';
import {state, persist, replaceLedger} from './store.js';
import {hub} from './hub.js';
import {toast, todayStr} from './util.js';

function csvCell(v) {
  if (v == null) return '';
  v = String(v);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function parseCSVLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function toCSV() {
  const lines = [];
  const push = (section, rows, cols) => {
    lines.push('#' + section);
    lines.push(cols.join(','));
    rows.forEach(r => lines.push(cols.map(c => csvCell(r[c])).join(',')));
    lines.push('');
  };
  push('funds', state.funds, ['id', 'type', 'label', 'amount', 'date', 'notes']);
  push('budget', state.budget, ['id', 'category', 'budgeted', 'notes']);
  push('actions', state.actions, ['id', 'title', 'due', 'status', 'notes']);
  push('sellers', state.sellers, ['id', 'name', 'contact', 'item', 'price', 'status', 'notes']);
  push('purchases', state.purchases, ['id', 'item', 'category', 'seller', 'price', 'date', 'receipt', 'driveLink']);
  return lines.join('\n');
}

export function fromCSV(text) {
  const lines = text.split(/\r?\n/);
  let section = null, cols = null;
  const fresh = {funds: [], budget: [], actions: [], sellers: [], purchases: []};
  for (const raw of lines) {
    if (!raw.trim()) { cols = null; continue; }
    if (raw[0] === '#') { section = raw.slice(1).trim(); cols = null; continue; }
    if (!section || !fresh[section]) continue;
    if (!cols) { cols = parseCSVLine(raw); continue; }
    const vals = parseCSVLine(raw), o = {};
    cols.forEach((c, i) => o[c] = vals[i] !== undefined ? vals[i] : '');
    ['amount', 'budgeted', 'price'].forEach(n => { if (o[n] !== undefined && o[n] !== '') o[n] = +o[n]; });
    if (!o.id) o.id = uid();
    fresh[section].push(o);
  }
  return fresh;
}

export function downloadCSV() {
  const blob = new Blob([toCSV()], {type: 'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'site-ledger-' + todayStr() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV exported');
}

export async function importCSVFile(file) {
  const text = await file.text();
  const fresh = fromCSV(text);
  if (!confirm('Import will REPLACE all current data with the CSV contents. Continue?')) return;
  replaceLedger(fresh);
  for (const s of ['funds', 'budget', 'actions', 'sellers', 'purchases']) await persist(s);
  hub.render();
  toast('CSV imported');
}
