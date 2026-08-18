import {DB_NAME, STORES} from './config.js';

let db;
export let state = {funds: [], budget: [], actions: [], sellers: [], purchases: []};
export let settings = {
  provider: 'openai', apiKey: '', model: '', apiBase: '', models: [], profiles: {},
  driveClientId: '', driveToken: null, driveFolderId: '', user: null, userSub: '', autoCsv: true,
  csvSyncedAt: '', csvDirty: false
};
export let session = {
  activeTab: 'funds',
  editing: null,
  editKind: null,
  photoCleared: false,
  pending: null,
  lastClientId: '',
  loggedIn: false,
  syncStatus: 'idle'
};

export function replaceLedger(next) {
  state.funds = next.funds || [];
  state.budget = next.budget || [];
  state.actions = next.actions || [];
  state.sellers = next.sellers || [];
  state.purchases = next.purchases || [];
}

export function emptyLedger() {
  replaceLedger({funds: [], budget: [], actions: [], sellers: [], purchases: []});
}

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      STORES.forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, {keyPath: s === 'meta' ? 'k' : 'id'}); });
    };
    req.onsuccess = e => { db = e.target.result; res(); };
    req.onerror = e => rej(e.target.error);
  });
}
function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
function idbAll(store) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readonly').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
function idbPut(store, val) {
  return new Promise((res, rej) => {
    const r = tx(store, 'readwrite').put(val);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
function idbGetMeta(k) {
  return new Promise(res => {
    const r = tx('meta', 'readonly').get(k);
    r.onsuccess = () => res(r.result ? r.result.v : null);
    r.onerror = () => res(null);
  });
}
function idbSetMeta(k, v) { return idbPut('meta', {k, v}); }

export async function loadAll() {
  await openDB();
  for (const s of ['funds', 'budget', 'actions', 'sellers', 'purchases']) state[s] = await idbAll(s);
  const st = await idbGetMeta('settings');
  if (st) settings = Object.assign(settings, st);
}

export function ledgerEmpty() {
  return ['funds', 'budget', 'actions', 'sellers', 'purchases'].every(s => !state[s].length);
}

export async function persist(store, opts) {
  opts = opts || {};
  await new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    os.clear();
    for (const row of state[store]) os.put(row);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  if (!opts.fromSync) settings.csvDirty = true;
}

export function snapshotAi() {
  return {
    provider: settings.provider,
    apiKey: settings.apiKey || '',
    model: settings.model || '',
    apiBase: settings.apiBase || '',
    models: Array.isArray(settings.models) ? settings.models.slice(0, 400) : [],
    driveFolderId: settings.driveFolderId || ''
  };
}
export function applyAi(p) {
  if (!p) return;
  if (p.provider) settings.provider = p.provider;
  if (p.apiKey != null) settings.apiKey = p.apiKey;
  if (p.model != null) settings.model = p.model;
  if (p.apiBase != null) settings.apiBase = p.apiBase;
  if (Array.isArray(p.models)) settings.models = p.models.slice(0, 400);
  if (p.driveFolderId) settings.driveFolderId = p.driveFolderId;
}
export function stashAi(sub) {
  if (!sub) return;
  if (!settings.profiles || typeof settings.profiles !== 'object') settings.profiles = {};
  settings.profiles[sub] = snapshotAi();
}
export function applyStashedAi(sub) {
  if (!sub) return;
  const p = settings.profiles && settings.profiles[sub];
  if (!p) {
    settings.apiKey = ''; settings.model = ''; settings.apiBase = ''; settings.models = []; settings.driveFolderId = '';
    return;
  }
  applyAi(p);
}
export async function saveSettings() {
  if (settings.userSub) stashAi(settings.userSub);
  const snap = Object.assign({}, settings, {driveToken: null});
  await idbSetMeta('settings', snap);
}
