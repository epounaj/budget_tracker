import {CATEGORIES, CUR} from './config.js?v=20260818x';

export const $ = id => document.getElementById(id);
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const money = n => CUR + Number(n || 0).toLocaleString(undefined, {maximumFractionDigits: 0});
export const moneyDec = n => CUR + Number(n || 0).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2});
export const fmtNum = n => {
  if (n == null || n === '') return '';
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return x.toLocaleString(undefined, {maximumFractionDigits: 2});
};

/** Line total: Qty × Rate when both are present, otherwise the stored amount. */
export function lineAmount(l) {
  if (!l) return 0;
  const qty = Number(parseMoney(l.qty));
  const rate = Number(parseMoney(l.rate));
  const amt = Number(parseMoney(l.amount));
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(rate) && rate > 0) {
    return Math.round(qty * rate * 100) / 100;
  }
  return Number.isFinite(amt) && amt !== 0 ? amt : 0;
}

export function sumLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return 0;
  return lines.reduce((s, l) => s + lineAmount(l), 0);
}
export function parseMoney(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let s = String(v).trim();
  if (!s) return '';
  s = s.replace(/[^\d.,-]/g, '');
  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) s = s.replace(/,/g, '');
  else if ((s.match(/,/g) || []).length && !s.includes('.')) s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : '';
}

export function parseDateISO(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0'), y = m[3];
    if (+mo <= 12) return y + '-' + mo + '-' + d;
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return '';
}
export const finiteNum = s => { const n = +s; return s !== '' && Number.isFinite(n); };
export const folderSafe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
export const driveQueryName = name => String(name || '').replace(/'/g, "\\'");

export function normalizeCategory(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'uncategorized' || low === 'other') return 'Other';
  const exact = CATEGORIES.find(c => c.toLowerCase() === low);
  if (exact) return exact;
  const hit = CATEGORIES.find(c => {
    const parts = c.toLowerCase().split(/\s*\/\s*/);
    return parts.some(p => low.includes(p) || p.includes(low));
  });
  return hit || s;
}

export function itemHaystack(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function itemsLookSame(a, b) {
  const x = itemHaystack(a), y = itemHaystack(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** Unit price: printed rate, else amount ÷ qty when qty > 0. */
export function unitPrice(l) {
  if (!l) return 0;
  const rate = Number(parseMoney(l.rate));
  if (Number.isFinite(rate) && rate > 0) return rate;
  const qty = Number(parseMoney(l.qty));
  const amt = lineAmount(l);
  if (Number.isFinite(qty) && qty > 0 && amt > 0) return Math.round((amt / qty) * 100) / 100;
  return 0;
}

/** 0–100. Strips punctuation so "term|" still matches Termicide. */
export function itemMatchScore(query, item) {
  const q = itemHaystack(query), h = itemHaystack(item);
  if (!q || !h) return 0;
  if (h === q) return 100;
  if (h.includes(q)) return 90;
  if (q.includes(h) && h.length >= 3) return 80;
  const qt = q.split(' ').filter(t => t.length >= 2);
  const ht = h.split(' ').filter(t => t.length >= 2);
  if (!qt.length) return 0;
  let hits = 0;
  qt.forEach(t => {
    if (ht.some(x => x === t || x.includes(t) || (t.length >= 3 && t.includes(x)))) hits++;
  });
  if (!hits) return 0;
  return Math.round(30 + (hits / qt.length) * 50);
}

/** Guess Electrical vs Plumbing (etc.) from an item name. Never invent a category without a keyword hit. */
export function guessCategoryFromItem(item, opts) {
  const allowed = opts && Array.isArray(opts.allowed)
    ? [...new Set(opts.allowed.map(normalizeCategory).filter(Boolean))]
    : [];
  const siblings = ((opts && opts.siblingItems) || []).map(itemHaystack);
  const h = itemHaystack(item);
  if (!h) return '';

  let elec = 0, plumb = 0;
  if (/iso\s*range|\bisorange\b|rouleau|cole\s*hta/.test(h)) elec += 3;
  if (/(insulat|isolant|\bscotch\b|electrical|\bcable\b|\bfil\b|\bwire\b|switch|breaker|\bmcb\b|conduit|\bled\b|\blamp\b|\bbulb\b)/.test(h)) elec += 2;
  if (/\btape\b/.test(h) && !/(thread|teflon|ptfe)/.test(h)) elec += 2;

  if (/(thread\s*tape|teflon|\bptfe\b)/.test(h)) plumb += 3;
  if (/\b(cpvc|upvc|pprc|pyn|rifen)\b/.test(h)) plumb += 3;
  if (/\b(elbow|coude|tuyau|tuyaux|pipe|pipes|bend|coupler|valve|robinet|siphon|tee|nipple|raccord|manchon|fitting)\b/.test(h)) plumb += 2;
  if (/\bpvc\b/.test(h) && !/(tape|insul|isol|cable|electrical)/.test(h)) plumb += 2;

  if (/(la\s*cole|\bcole\b|\bcolle\b|adhesi|\bglue\b)/.test(h) && !/cole\s*hta/.test(h)) {
    const pipesAround = siblings.some(s => /(pvc|pipe|tuyau|elbow|cpvc|pyn|rifen|bend)/.test(s));
    if (pipesAround) plumb += 2;
    else elec += 1;
  }

  let guess = '';
  if (plumb > elec) guess = 'Plumbing';
  else if (elec > plumb) guess = 'Electrical';
  else if (elec > 0) {
    if (allowed.includes('Plumbing') && !allowed.includes('Electrical')) guess = 'Plumbing';
    else if (allowed.includes('Electrical') && !allowed.includes('Plumbing')) guess = 'Electrical';
    else guess = 'Electrical';
  }

  if (!guess) {
    const named = CATEGORIES.find(c => {
      if (c === 'Other') return false;
      const n = itemHaystack(c);
      return n && (h.includes(n) || n.split(' ').every(p => p && h.includes(p)));
    });
    if (named) guess = named;
  }

  if (allowed.length) {
    if (guess && allowed.includes(guess)) return guess;
    return '';
  }
  return guess || '';
}

export function purchaseCategories(p) {
  if (!p) return [];
  if (Array.isArray(p.categories) && p.categories.length) {
    return [...new Set(p.categories.map(normalizeCategory).filter(Boolean))];
  }
  const fromLines = Array.isArray(p.lines)
    ? [...new Set(p.lines.map(l => normalizeCategory(l && l.category)).filter(Boolean))]
    : [];
  if (fromLines.length) return fromLines;
  const one = normalizeCategory(p.category);
  return one ? [one] : [];
}

export function summarizePurchase(seller, lines) {
  const names = (lines || []).map(l => String((l && l.item) || '').trim()).filter(Boolean);
  const cats = [...new Set((lines || []).map(l => normalizeCategory(l && l.category)).filter(Boolean))];
  if (!names.length) return seller || '';
  let label = names.length === 1 ? names[0] : (names[0] + ' + ' + (names.length - 1) + ' more');
  label = label.replace(/\s+/g, ' ').slice(0, 56);
  if (cats.length) label += ' · ' + cats.slice(0, 2).join(', ');
  return label;
}

export function driveFolderName(raw) {
  const n = folderSafe(normalizeCategory(raw) || raw);
  if (!n || n.toLowerCase() === 'uncategorized') return 'Other';
  return n;
}

let toastT;
export function toast(msg, ms) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms || (msg && msg.length > 80 ? 7000 : 2600));
}

export function compressImage(file, maxDim, quality) {
  maxDim = maxDim || 1000;
  quality = quality || 0.6;
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
        else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = rej;
      img.src = r.result;
    };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function dataURLtoBlob(d) {
  const [meta, b64] = d.split(',');
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], {type: mime});
}

export function extFromFile(file) {
  const n = (file && file.name) || '';
  const m = n.match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  const t = (file && file.type) || '';
  if (t === 'image/png') return 'png';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/heic' || t === 'image/heif') return 'heic';
  return 'jpg';
}
