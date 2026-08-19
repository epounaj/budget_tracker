import {uid} from './util.js?v=20260819j';
import {state, persist, replaceLedger} from './store.js?v=20260819j';
import {hub} from './hub.js?v=20260819j';
import {toast, todayStr} from './util.js?v=20260819j';

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
  push('funds', state.funds, ['id', 'type', 'label', 'amount', 'date', 'notes', 'updatedAt']);
  push('budget', state.budget.map(b => {
    const mat = (b.budgetedMaterials != null && b.budgetedMaterials !== '') ? +b.budgetedMaterials || 0 : +b.budgeted || 0;
    const lab = +b.budgetedLabour || 0;
    return Object.assign({}, b, {
      budgeted: mat + lab,
      budgetedMaterials: mat,
      budgetedLabour: lab
    });
  }), ['id', 'category', 'budgeted', 'budgetedMaterials', 'budgetedLabour', 'notes', 'updatedAt']);
  push('actions', state.actions, ['id', 'title', 'due', 'status', 'notes', 'updatedAt']);
  push('sellers', state.sellers.map(s => Object.assign({}, s, {
    photos: Array.isArray(s.photos) ? JSON.stringify(s.photos) : (s.photos || ''),
    photoLinks: Array.isArray(s.photoLinks) ? JSON.stringify(s.photoLinks) : (s.photoLinks || ''),
    quoteLines: Array.isArray(s.quoteLines) ? JSON.stringify(s.quoteLines) : (s.quoteLines || '')
  })), ['id', 'name', 'contact', 'item', 'price', 'status', 'notes', 'photos', 'photoLinks', 'quoteLines', 'updatedAt']);
  push('purchases', state.purchases.map(p => Object.assign({}, p, {
    lines: Array.isArray(p.lines) ? JSON.stringify(p.lines) : (p.lines || ''),
    categories: Array.isArray(p.categories) ? JSON.stringify(p.categories) : (p.categories || ''),
    driveFileIds: Array.isArray(p.driveFileIds) ? JSON.stringify(p.driveFileIds) : (p.driveFileIds || ''),
    driveFiles: Array.isArray(p.driveFiles) ? JSON.stringify(p.driveFiles) : (p.driveFiles || '')
  })), ['id', 'item', 'category', 'categories', 'seller', 'payee', 'price', 'date', 'receipt', 'notes', 'paymentMethod', 'spendKind', 'lines', 'driveLink', 'driveFileId', 'driveFolder', 'driveFileIds', 'driveFiles', 'updatedAt']);
  push('labour', (state.labour || []).map(p => Object.assign({}, p, {
    photos: Array.isArray(p.photos) ? JSON.stringify(p.photos) : (p.photos || ''),
    photoLinks: Array.isArray(p.photoLinks) ? JSON.stringify(p.photoLinks) : (p.photoLinks || '')
  })), ['id', 'payee', 'category', 'amount', 'date', 'method', 'notes', 'spendKind', 'photos', 'photoLinks', 'thumb', 'driveLink', 'driveFileId', 'updatedAt']);
  return lines.join('\n');
}

export function fromCSV(text) {
  const lines = text.split(/\r?\n/);
  let section = null, cols = null;
  const fresh = {funds: [], budget: [], actions: [], sellers: [], purchases: [], labour: []};
  for (const raw of lines) {
    if (!raw.trim()) { cols = null; continue; }
    if (raw[0] === '#') { section = raw.slice(1).trim(); cols = null; continue; }
    if (!section || !fresh[section]) continue;
    if (!cols) { cols = parseCSVLine(raw); continue; }
    const vals = parseCSVLine(raw), o = {};
    cols.forEach((c, i) => o[c] = vals[i] !== undefined ? vals[i] : '');
    ['amount', 'budgeted', 'budgetedMaterials', 'budgetedLabour', 'price'].forEach(n => { if (o[n] !== undefined && o[n] !== '') o[n] = +o[n]; });
    if (o.lines && typeof o.lines === 'string' && o.lines.trim().startsWith('[')) {
      try { o.lines = JSON.parse(o.lines); } catch (e) {}
    }
    if (o.photos && typeof o.photos === 'string' && o.photos.trim().startsWith('[')) {
      try { o.photos = JSON.parse(o.photos); } catch (e) {}
    }
    if (o.photoLinks && typeof o.photoLinks === 'string' && o.photoLinks.trim().startsWith('[')) {
      try { o.photoLinks = JSON.parse(o.photoLinks); } catch (e) {}
    }
    if (o.quoteLines && typeof o.quoteLines === 'string' && o.quoteLines.trim().startsWith('[')) {
      try { o.quoteLines = JSON.parse(o.quoteLines); } catch (e) {}
    }
    if (o.driveFileIds && typeof o.driveFileIds === 'string' && o.driveFileIds.trim().startsWith('[')) {
      try { o.driveFileIds = JSON.parse(o.driveFileIds); } catch (e) {}
    }
    if (o.driveFiles && typeof o.driveFiles === 'string' && o.driveFiles.trim().startsWith('[')) {
      try { o.driveFiles = JSON.parse(o.driveFiles); } catch (e) {}
    }
    if (o.categories && typeof o.categories === 'string' && o.categories.trim().startsWith('[')) {
      try { o.categories = JSON.parse(o.categories); } catch (e) {}
    }
    if (!o.id) o.id = uid();
    if (section === 'budget') {
      if (o.budgetedMaterials == null || o.budgetedMaterials === '') o.budgetedMaterials = +o.budgeted || 0;
      if (o.budgetedLabour == null || o.budgetedLabour === '') o.budgetedLabour = 0;
      o.budgeted = (+o.budgetedMaterials || 0) + (+o.budgetedLabour || 0);
    }
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
  for (const s of ['funds', 'budget', 'actions', 'sellers', 'purchases', 'labour']) await persist(s);
  hub.render();
  if (hub.scheduleCsvSync) hub.scheduleCsvSync();
  toast('CSV imported');
}
