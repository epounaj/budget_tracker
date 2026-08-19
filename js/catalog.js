/** Unified shop catalog from seller quotes + purchase lines. */
import {CATEGORIES} from './config.js?v=20260819d';
import {settings, state} from './store.js?v=20260819d';
import {
  itemHaystack, itemsLookSame, itemMatchScore, guessCategoryFromItem, normalizeCategory,
  lineAmount, unitPrice, purchaseCategories
} from './util.js?v=20260819d';
import {callJsonCompletion} from './ai.js?v=20260819d';

export const CATALOG_PAGE_SIZE = 10;

function mostCommon(arr) {
  const counts = {};
  let best = '', n = 0;
  (arr || []).forEach(v => {
    const k = String(v || '').trim();
    if (!k) return;
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > n) { n = counts[k]; best = k; }
  });
  return best;
}

function isoDay(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

export function sellerPhotoList(s) {
  if (!s) return [];
  const links = Array.isArray(s.photoLinks) ? s.photoLinks : [];
  return (Array.isArray(s.photos) ? s.photos : []).map((ph, i) => {
    const ln = links[i] || {};
    return {
      thumb: (ph && (ph.thumb || ph.thumbDataUrl)) || '',
      driveFileId: (ph && ph.driveFileId) || ln.id || '',
      webViewLink: (ph && ph.webViewLink) || ln.webViewLink || '',
      kind: 'seller',
      sellerId: s.id,
      idx: i
    };
  }).filter(p => p.thumb || p.driveFileId);
}

function purchasePhotoList(p) {
  if (!p) return [];
  const files = Array.isArray(p.driveFiles) && p.driveFiles.length
    ? p.driveFiles
    : (p.driveFileId ? [{id: p.driveFileId, webViewLink: p.driveLink}] : []);
  if (!p.thumb && !files.length) return [];
  return [{
    thumb: p.thumb || '',
    driveFileId: (files[0] && files[0].id) || p.driveFileId || '',
    webViewLink: (files[0] && files[0].webViewLink) || p.driveLink || '',
    kind: 'purchase',
    purchaseId: p.id,
    idx: 0
  }];
}

function dedupePhotos(photos) {
  const seen = new Set();
  return (photos || []).filter(p => {
    const k = (p && (p.driveFileId || p.thumb)) || '';
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function catalogSameItem(a, b) {
  const x = itemHaystack(a), y = itemHaystack(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 5) return false;
  return itemsLookSame(a, b);
}

function offerFromQuote(s, l) {
  const item = String((l && l.item) || '').trim();
  const cat = normalizeCategory(l && l.category) || guessCategoryFromItem(item) || '';
  return {
    item,
    seller: String((l && l.seller) || s.name || '').trim(),
    contact: String((l && l.contact) || s.contact || '').trim(),
    qty: l && l.qty,
    rate: l && l.rate,
    amount: lineAmount(l),
    unit: unitPrice(l),
    category: cat,
    date: isoDay(s.updatedAt),
    notes: s.notes || '',
    source: 'quote',
    sellerId: s.id,
    purchaseId: '',
    photos: sellerPhotoList(s)
  };
}

function offerFromPurchase(p, l, siblingItems) {
  const item = String((l && l.item) || '').trim();
  const cats = purchaseCategories(p);
  const cat = normalizeCategory(l && l.category)
    || (cats.length === 1 ? cats[0] : '')
    || guessCategoryFromItem(item, {allowed: cats, siblingItems})
    || '';
  return {
    item,
    seller: String(p.seller || '').trim(),
    contact: '',
    qty: l && l.qty,
    rate: l && l.rate,
    amount: lineAmount(l),
    unit: unitPrice(l),
    category: cat,
    date: isoDay(p.date) || isoDay(p.updatedAt),
    notes: p.notes || '',
    source: 'purchase',
    sellerId: '',
    purchaseId: p.id,
    photos: purchasePhotoList(p)
  };
}

export function collectOffers() {
  const offers = [];
  (state.sellers || []).forEach(s => {
    const lines = Array.isArray(s.quoteLines) ? s.quoteLines : [];
    let n = 0;
    lines.forEach(l => {
      if (!String((l && l.item) || '').trim()) return;
      offers.push(offerFromQuote(s, l));
      n++;
    });
    if (!n && s.item) {
      offers.push(offerFromQuote(s, {
        item: s.item,
        seller: s.name,
        contact: s.contact,
        rate: s.price,
        amount: s.price,
        qty: '',
        category: guessCategoryFromItem(s.item) || ''
      }));
    }
  });
  (state.purchases || []).forEach(p => {
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const siblingItems = lines.map(l => l && l.item);
    if (lines.length) {
      lines.forEach(l => {
        if (!String((l && l.item) || '').trim()) return;
        offers.push(offerFromPurchase(p, l, siblingItems));
      });
    }
  });
  return offers;
}

export function buildCatalog() {
  const offers = collectOffers();
  const groups = [];
  offers.forEach(off => {
    const found = groups.find(g => catalogSameItem(g.item, off.item));
    if (found) found.offers.push(off);
    else groups.push({item: off.item, offers: [off]});
  });
  return groups.map((g, i) => {
    const priced = g.offers.filter(o => o.unit > 0).slice().sort((a, b) => a.unit - b.unit);
    const ranked = priced.length ? priced : g.offers.slice();
    const best = ranked[0] || g.offers[0];
    const cats = g.offers.map(o => o.category).filter(Boolean);
    const category = mostCommon(cats) || guessCategoryFromItem(g.item) || 'Other';
    const dates = g.offers.map(o => o.date).filter(Boolean).sort();
    const date = dates.length ? dates[dates.length - 1] : '';
    const photos = dedupePhotos(g.offers.flatMap(o => o.photos || []));
    const hay = itemHaystack([
      g.item, category, best && best.seller, best && best.contact,
      g.offers.map(o => [o.item, o.seller, o.contact, o.category, o.notes].join(' ')).join(' ')
    ].join(' '));
    return {
      id: itemHaystack(g.item) || ('row-' + i),
      item: (best && best.item) || g.item,
      category,
      date,
      bestSeller: (best && best.seller) || '',
      bestContact: (best && best.contact) || '',
      bestUnit: (best && best.unit) || 0,
      bestSource: (best && best.source) || '',
      samples: priced.length,
      avg: priced.length ? priced.reduce((s, o) => s + o.unit, 0) / priced.length : 0,
      offers: ranked,
      photos,
      hay
    };
  }).sort((a, b) => {
    const c = String(a.category).localeCompare(String(b.category));
    return c || String(a.item).localeCompare(String(b.item));
  });
}

export function filterCatalog(rows, query, category) {
  let out = rows || [];
  if (category) out = out.filter(r => r.category === category);
  const q = itemHaystack(query);
  if (!q) return out;
  const tokens = q.split(' ').filter(Boolean);
  return out.filter(r => {
    const hay = r.hay || itemHaystack([r.item, r.bestSeller, r.category, r.bestContact].join(' '));
    return tokens.every(t => hay.includes(t));
  });
}

export function catalogPage(rows, page, size) {
  size = size || CATALOG_PAGE_SIZE;
  const total = (rows || []).length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const p = Math.min(Math.max(1, page || 1), pages);
  const start = (p - 1) * size;
  return {page: p, pages, total, rows: (rows || []).slice(start, start + size)};
}

export function parseShoppingList(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  lines.forEach((line, idx) => {
    const parts = line.split(/[,;\t]/).map(s => s.trim()).filter(s => s !== '');
    if (!parts.length) return;
    if (idx === 0 && /^(item|name|description|product|qty|quantity)s?$/i.test(parts[0])) return;
    let name = parts[0];
    let qty = '';
    const qtyFrom = parts.find((p, i) => i > 0 && /^\d+([.,]\d+)?$/.test(p));
    if (qtyFrom) qty = qtyFrom.replace(',', '.');
    const lead = name.match(/^(\d+(?:\.\d+)?)\s*[x×]\s+(.+)/i);
    if (lead) { qty = lead[1]; name = lead[2]; }
    const trail = name.match(/^(.+?)\s+[x×]\s*(\d+(?:\.\d+)?)$/i);
    if (!lead && trail) { name = trail[1]; qty = trail[2]; }
    name = name.replace(/^[-*•]+\s*/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!name || name.length < 2) return;
    if (/^(qty|quantity|rate|price|amount|seller)$/i.test(name)) return;
    items.push({name, qty});
  });
  return items;
}

export function matchShoppingList(needItems, catalog) {
  return (needItems || []).map(need => {
    let best = null, bestScore = 0;
    const alts = [];
    (catalog || []).forEach(row => {
      let score = itemMatchScore(need.name, row.item);
      if (score < 40 && itemsLookSame(need.name, row.item) && itemHaystack(need.name).length >= 4) score = Math.max(score, 70);
      if (score < 40) return;
      alts.push({row, score});
      if (score > bestScore || (score === bestScore && row.bestUnit && (!best || row.bestUnit < best.bestUnit))) {
        bestScore = score;
        best = row;
      }
    });
    alts.sort((a, b) => b.score - a.score || (a.row.bestUnit || 9e9) - (b.row.bestUnit || 9e9));
    return {need, match: best, score: bestScore, alts: alts.slice(0, 4)};
  });
}

export function groupQuoteBySeller(matches) {
  const bySeller = new Map();
  (matches || []).forEach(m => {
    const key = m.match ? (m.match.bestSeller || 'Unknown seller') : 'Unmatched';
    if (!bySeller.has(key)) bySeller.set(key, []);
    bySeller.get(key).push(m);
  });
  return bySeller;
}

export async function aiAssistMatches(unmatchedNames, catalogNames) {
  if (!settings.apiKey || !unmatchedNames.length || !catalogNames.length) return [];
  const needs = unmatchedNames.slice(0, 40);
  const catalog = catalogNames.slice(0, 180);
  const prompt = 'Match shopping-list names to catalog item names for a construction project in Mauritius. '
    + 'Reply ONLY JSON: {"matches":[{"need":string,"catalog":string}]}. '
    + '"catalog" must be copied exactly from the catalog list, or "" if there is no reasonable match. '
    + 'Needs: ' + JSON.stringify(needs) + '. Catalog: ' + JSON.stringify(catalog) + '.';
  try {
    const data = await callJsonCompletion(prompt);
    const rows = (data && Array.isArray(data.matches)) ? data.matches : [];
    return rows.map(r => ({need: String((r && r.need) || '').trim(), catalog: String((r && r.catalog) || '').trim()}))
      .filter(r => r.need && r.catalog);
  } catch (e) {
    return [];
  }
}

export function applyAiMatches(matches, hints, catalog) {
  if (!hints || !hints.length) return matches;
  const byNeed = {};
  hints.forEach(h => { if (h.need) byNeed[itemHaystack(h.need)] = h.catalog; });
  return matches.map(m => {
    if (m.match) return m;
    const hint = byNeed[itemHaystack(m.need.name)];
    if (!hint) return m;
    const row = catalog.find(r => r.item === hint || itemsLookSame(r.item, hint));
    if (!row) return m;
    return {need: m.need, match: row, score: 75, alts: [{row, score: 75}]};
  });
}

export function catalogCategories(rows) {
  const present = new Set((rows || []).map(r => r.category).filter(Boolean));
  return CATEGORIES.filter(c => present.has(c)).concat([...present].filter(c => !CATEGORIES.includes(c)));
}
