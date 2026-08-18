import {CATEGORIES, CUR} from './config.js?v=20260818c';

export const $ = id => document.getElementById(id);
export const todayStr = () => new Date().toISOString().slice(0, 10);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const money = n => CUR + Number(n || 0).toLocaleString(undefined, {maximumFractionDigits: 0});
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
  const exact = CATEGORIES.find(c => c.toLowerCase() === low);
  if (exact) return exact;
  const hit = CATEGORIES.find(c => {
    const parts = c.toLowerCase().split(/\s*\/\s*/);
    return parts.some(p => low.includes(p) || p.includes(low));
  });
  return hit || s;
}

let toastT;
export function toast(msg, ms) {
  const t = $('toast');
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
