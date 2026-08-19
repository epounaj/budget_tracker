import {GOOGLE_CLIENT_ID, PROFILE_FILE, CSV_FILE} from './config.js?v=20260819h';
import {settings, state, saveSettings, applyAi, persist, snapshotAi, replaceLedger, session, ledgerEmpty, ledgerRecordCount, snapshotLedger, mergeLedgers, LEDGER_STORES, clearSavedToken} from './store.js?v=20260819h';
import {$, toast, todayStr, folderSafe, driveQueryName, normalizeCategory, dataURLtoBlob, extFromFile, compressImage, driveFolderName} from './util.js?v=20260819h';
import {toCSV, fromCSV} from './csv.js?v=20260819h';
import {hub} from './hub.js?v=20260819h';

export function appClientId() {
  const inp = $('login-client-id');
  return ((inp && inp.value.trim()) || GOOGLE_CLIENT_ID || settings.driveClientId || session.lastClientId || '').trim();
}
export function driveApiEnableUrl() {
  const cid = appClientId() || GOOGLE_CLIENT_ID || '';
  const proj = (cid.match(/^(\d+)/) || [])[1];
  return 'https://console.cloud.google.com/apis/library/drive.googleapis.com' + (proj ? ('?project=' + proj) : '');
}

export async function driveFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({'Authorization': 'Bearer ' + settings.driveToken}, opts.headers || {});
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, opts);
    if (r.status === 401) { clearSavedToken(); throw new Error('Drive session expired — sign in again'); }
    if (r.ok) return r;
    const transient = r.status === 429 || r.status === 408 || r.status >= 500;
    if (transient && i < 2) {
      await new Promise(res => setTimeout(res, 350 * (i + 1)));
      continue;
    }
    let msg = 'Google Drive error ' + r.status, reason = '';
    try {
      const j = await r.json();
      if (j.error && j.error.message) msg = j.error.message;
      if (j.error && j.error.errors && j.error.errors[0]) reason = j.error.errors[0].reason || '';
    } catch (e) {}
    if (r.status === 403 && (/accessNotConfigured|has not been used|is disabled|Drive API/i.test(msg + ' ' + reason)))
      msg = 'Enable the Google Drive API (click Enable Drive API in Settings), wait a minute, then tap Create Drive folder.';
    throw new Error(msg);
  }
  throw new Error('Drive request failed');
}

async function listSiteLedgerFolders() {
  const q = encodeURIComponent("name='Site Ledger' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,createdTime)&spaces=drive&orderBy=createdTime&pageSize=100');
  const j = await r.json();
  return j.files || [];
}

async function csvMetaInFolder(folderId) {
  const q = encodeURIComponent("name='" + driveQueryName(CSV_FILE) + "' and '" + folderId + "' in parents and trashed=false");
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,modifiedTime,size)&spaces=drive&orderBy=modifiedTime%20desc');
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}

/** Pick one Site Ledger folder: newest CSV wins. Cached ids must not pin a stale duplicate. */
export async function ensureDriveFolder() {
  if (!settings.driveToken) throw new Error('Sign in first');
  const folders = await listSiteLedgerFolders();
  const scored = [];
  for (const f of folders) scored.push({folder: f, csv: await csvMetaInFolder(f.id)});
  const withCsv = scored.filter(x => x.csv);
  let chosen = null;
  if (withCsv.length) {
    withCsv.sort((a, b) => {
      const ta = Date.parse(a.csv.modifiedTime) || 0;
      const tb = Date.parse(b.csv.modifiedTime) || 0;
      if (tb !== ta) return tb - ta;
      return (Number(b.csv.size) || 0) - (Number(a.csv.size) || 0);
    });
    chosen = withCsv[0].folder;
  } else if (folders.length) {
    chosen = folders.find(f => f.id === settings.driveFolderId) || folders[0];
  }
  if (!chosen) {
    const cr = await driveFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Site Ledger', mimeType: 'application/vnd.google-apps.folder', parents: ['root']})
    });
    const cj = await cr.json();
    if (!cj.id) throw new Error('Google did not create the Site Ledger folder');
    settings.driveFolderId = cj.id;
  } else {
    settings.driveFolderId = chosen.id;
  }
  await saveSettings();
  return settings.driveFolderId;
}

async function findDriveChild(parentId, name, folderOnly) {
  const extra = folderOnly ? " and mimeType='application/vnd.google-apps.folder'" : '';
  const q = encodeURIComponent("name='" + driveQueryName(name) + "' and '" + parentId + "' in parents and trashed=false" + extra);
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,modifiedTime)&spaces=drive&orderBy=modifiedTime%20desc');
  const j = await r.json();
  return (j.files && j.files[0] && j.files[0].id) || null;
}

const childFolderLocks = {};
async function listChildFolders(parentId) {
  const q = encodeURIComponent("'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,createdTime)&spaces=drive&orderBy=createdTime&pageSize=100');
  const j = await r.json();
  return j.files || [];
}
async function ensureChildFolder(parentId, name) {
  name = folderSafe(name) || 'Other';
  if (name.toLowerCase() === 'uncategorized') name = 'Other';
  const key = parentId + '|' + name.toLowerCase();
  if (childFolderLocks[key]) return childFolderLocks[key];
  childFolderLocks[key] = (async () => {
    const kids = await listChildFolders(parentId);
    const hit = kids.find(f => String(f.name || '').toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    const cr = await driveFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId]})
    });
    const cj = await cr.json();
    if (!cj.id) throw new Error('Could not create Drive folder ' + name);
    return cj.id;
  })();
  try { return await childFolderLocks[key]; }
  finally { setTimeout(() => { delete childFolderLocks[key]; }, 400); }
}
export async function findDriveFile(name) {
  await ensureDriveFolder();
  return findDriveChild(settings.driveFolderId, name, false);
}
export async function findDriveFileMeta(name) {
  await ensureDriveFolder();
  const q = encodeURIComponent("name='" + driveQueryName(name) + "' and '" + settings.driveFolderId + "' in parents and trashed=false");
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,modifiedTime)&spaces=drive&orderBy=modifiedTime%20desc');
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}
export async function deleteDriveFile(id) {
  if (!id) return;
  try { await driveFetch('https://www.googleapis.com/drive/v3/files/' + id, {method: 'DELETE'}); } catch (e) {}
}
export async function upsertDriveFile(name, blob) {
  const id = await findDriveFile(name);
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(id ? {name} : {name, parents: [settings.driveFolderId]})], {type: 'application/json'}));
  form.append('file', blob);
  const url = id
    ? 'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=multipart&fields=id,modifiedTime'
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime';
  const r = await driveFetch(url, {method: id ? 'PATCH' : 'POST', body: form});
  return r.json();
}
export async function loadProfileFromDrive() {
  const id = await findDriveFile(PROFILE_FILE);
  if (!id) return;
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
  if (!r.ok) return;
  applyAi(await r.json());
}
export async function saveProfileToDrive() {
  if (!settings.driveToken) return;
  const body = snapshotAi();
  const blob = new Blob([JSON.stringify({
    provider: body.provider, apiKey: body.apiKey, model: body.model,
    apiBase: body.apiBase, models: body.models, autoCsv: true,
    driveFolderId: settings.driveFolderId || body.driveFolderId || ''
  })], {type: 'application/json'});
  await upsertDriveFile(PROFILE_FILE, blob);
}

async function applyLedger(ledger, meta) {
  replaceLedger(ledger);
  for (const s of LEDGER_STORES) await persist(s, {fromSync: true});
  settings.csvDirty = false;
  settings.csvSyncedAt = (meta && meta.modifiedTime) || new Date().toISOString();
  await saveSettings();
  hub.render();
  hydratePurchaseThumbs();
}

async function loadCsvFromMeta(meta) {
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files/' + meta.id + '?alt=media');
  if (!r.ok) throw new Error('Could not read ledger from Drive');
  return fromCSV(await r.text());
}

async function applyDriveCsv(meta) {
  await applyLedger(await loadCsvFromMeta(meta), meta);
}

async function pushCsvToDrive(quiet) {
  const out = await upsertDriveFile(CSV_FILE, new Blob([toCSV()], {type: 'text/csv'}));
  settings.csvDirty = false;
  settings.csvSyncedAt = (out && out.modifiedTime) || new Date().toISOString();
  await saveSettings();
  if (!quiet) toast('Synced to Drive');
}

function finishSync(hint, result) {
  session.syncHint = hint;
  session.syncStatus = 'idle';
  hub.updateSyncPill();
  return result;
}

/** Drive CSV is the shared ledger. IndexedDB is only a cache. */
export async function reconcileLedgerWithDrive(opts) {
  opts = opts || {};
  if (!settings.driveToken) {
    session.syncHint = 'local';
    hub.updateSyncPill();
    return 'offline';
  }
  session.syncStatus = 'syncing';
  hub.updateSyncPill();
  try {
    await ensureDriveFolder();
    const folders = await listSiteLedgerFolders();
    const copies = [];
    for (const f of folders) {
      const meta = await csvMetaInFolder(f.id);
      if (!meta) continue;
      copies.push({folderId: f.id, meta, ledger: await loadCsvFromMeta(meta)});
    }
    copies.sort((a, b) => (Date.parse(b.meta.modifiedTime) || 0) - (Date.parse(a.meta.modifiedTime) || 0));
    let driveLedger = null;
    let newestMeta = copies[0] ? copies[0].meta : null;
    for (const c of copies) {
      driveLedger = driveLedger ? mergeLedgers(driveLedger, c.ledger) : c.ledger;
    }
    const extraFolders = copies.filter(c => c.folderId !== settings.driveFolderId);
    const localSnap = snapshotLedger();
    const empty = ledgerEmpty(localSnap);
    const driveEmpty = !driveLedger || ledgerEmpty(driveLedger);

    if (opts.forcePull && newestMeta && !driveEmpty) {
      await applyLedger(driveLedger, newestMeta);
      if (extraFolders.length) {
        await pushCsvToDrive(true);
        for (const extra of extraFolders) {
          try { await deleteDriveFile(extra.meta.id); } catch (e) {}
        }
      }
      if (!opts.quiet) toast('Loaded from Drive');
      return finishSync('drive', 'pulled');
    }
    if (driveEmpty) {
      if (!empty) {
        await pushCsvToDrive(true);
        if (!opts.quiet) toast('Saved to Google Drive');
        return finishSync('drive', 'pushed');
      }
      return finishSync('drive', 'empty');
    }
    if (empty) {
      await applyLedger(driveLedger, newestMeta);
      if (extraFolders.length) {
        await pushCsvToDrive(true);
        for (const extra of extraFolders) {
          try { await deleteDriveFile(extra.meta.id); } catch (e) {}
        }
      }
      if (!opts.quiet) toast('Loaded from Drive');
      return finishSync('drive', 'pulled');
    }

    const driveMs = Date.parse(newestMeta.modifiedTime) || 0;
    const lastMs = Date.parse(settings.csvSyncedAt) || 0;
    const dirty = !!settings.csvDirty;
    const driveNewer = driveMs > lastMs + 2000;

    if (!dirty && lastMs && !driveNewer && !extraFolders.length) {
      return finishSync('drive', 'ok');
    }
    if (dirty && !driveNewer && lastMs && !extraFolders.length) {
      await pushCsvToDrive(true);
      if (!opts.quiet) toast('Saved to Google Drive');
      return finishSync('drive', 'pushed');
    }
    if (!dirty && lastMs && driveNewer && !extraFolders.length) {
      await applyLedger(driveLedger, newestMeta);
      if (!opts.quiet) toast('Loaded from Drive');
      return finishSync('drive', 'pulled');
    }

    const preferDrive = driveNewer || ledgerRecordCount(driveLedger) >= ledgerRecordCount(localSnap);
    const merged = mergeLedgers(preferDrive ? driveLedger : localSnap, preferDrive ? localSnap : driveLedger);
    await applyLedger(merged, newestMeta);
    await pushCsvToDrive(true);
    for (const extra of extraFolders) {
      try { await deleteDriveFile(extra.meta.id); } catch (e) {}
    }
    if (!opts.quiet) {
      if (extraFolders.length) toast('Merged Drive copies into one ledger');
      else toast('Merged with Drive — phone and PC now share one ledger');
    }
    return finishSync('merged', 'merged');
  } catch (e) {
    session.syncStatus = 'error';
    session.syncHint = 'local';
    hub.updateSyncPill();
    throw e;
  }
}

export async function pullCsvFromDrive() {
  return reconcileLedgerWithDrive({forcePull: true});
}

async function hydratePurchaseThumbs() {
  if (!settings.driveToken) return;
  let changed = false;
  for (const p of state.purchases) {
    if (p.thumb || !p.driveFileId) continue;
    try {
      const r = await driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(p.driveFileId) + '?alt=media');
      const blob = await r.blob();
      const file = new File([blob], 'receipt.jpg', {type: blob.type || 'image/jpeg'});
      p.thumb = await compressImage(file, 720, 0.82);
      changed = true;
    } catch (e) {}
  }
  if (changed) {
    await persist('purchases', {fromSync: true});
    hub.render();
  }
}

/** Uploads the original camera/gallery file (not the OCR thumbnail). */
export async function uploadOriginalToDrive(fileOrBlob, info) {
  info = info || {};
  await ensureDriveFolder();
  const receiptsId = await ensureChildFolder(settings.driveFolderId, 'Receipts');
  const catName = driveFolderName(info.category);
  const catId = await ensureChildFolder(receiptsId, catName);
  const ext = info.ext || extFromFile(fileOrBlob) || 'jpg';
  const bits = [info.date || todayStr(), folderSafe(info.seller), folderSafe(info.item), folderSafe(info.receipt)].filter(Boolean);
  const fname = (bits.join('_') || ('receipt-' + todayStr())).slice(0, 90) + '.' + ext;
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : dataURLtoBlob(fileOrBlob);
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({name: fname, parents: [catId]})], {type: 'application/json'}));
  form.append('file', blob, fname);
  const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {method: 'POST', body: form});
  const out = await r.json();
  out.folderPath = 'Site Ledger / Receipts / ' + catName;
  return out;
}

/** Upload seller reference images (storefront, quote screenshot, catalog, etc). */
export async function uploadSellerOriginalToDrive(fileOrBlob, info) {
  info = info || {};
  await ensureDriveFolder();
  const sellersId = await ensureChildFolder(settings.driveFolderId, 'Sellers');
  const sellerName = folderSafe(info.name) || 'Unknown Seller';
  const sellerId = await ensureChildFolder(sellersId, sellerName);
  const ext = info.ext || extFromFile(fileOrBlob) || 'jpg';
  const bits = [info.date || todayStr(), sellerName, folderSafe(info.item), folderSafe(info.tag)].filter(Boolean);
  const fname = (bits.join('_') || ('seller-' + todayStr())).slice(0, 90) + '.' + ext;
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : dataURLtoBlob(fileOrBlob);
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({name: fname, parents: [sellerId]})], {type: 'application/json'}));
  form.append('file', blob, fname);
  const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {method: 'POST', body: form});
  const out = await r.json();
  out.folderPath = 'Site Ledger / Sellers / ' + sellerName;
  return out;
}

let csvSyncT;
let syncInFlight = null;
let syncRequested = false;
let syncRequestOpts = {};

function uiBusy() {
  return ['overlay', 'settings-overlay', 'lightbox', 'login-screen'].some(id => {
    const el = $(id);
    return el && el.classList.contains('show');
  });
}

async function driveCsvIsNewer() {
  const folderId = settings.driveFolderId;
  if (!folderId) return true;
  const meta = await csvMetaInFolder(folderId);
  if (!meta) return true;
  const driveMs = Date.parse(meta.modifiedTime) || 0;
  const lastMs = Date.parse(settings.csvSyncedAt) || 0;
  return driveMs > lastMs + 2000;
}

export async function runSync(opts) {
  opts = opts || {};
  if (!settings.driveToken) return 'offline';
  if (syncInFlight) {
    syncRequested = true;
    syncRequestOpts = opts;
    return syncInFlight;
  }
  if (!opts.light) {
    session.syncStatus = 'syncing';
    hub.updateSyncPill();
  }
  syncInFlight = (async () => {
    try {
      if (opts.light && !settings.csvDirty) {
        const newer = await driveCsvIsNewer();
        if (!newer) {
          if (session.syncHint === 'local') {
            session.syncHint = 'drive';
            hub.updateSyncPill();
          }
          return 'ok';
        }
        session.syncStatus = 'syncing';
        hub.updateSyncPill();
      }
      return await reconcileLedgerWithDrive({quiet: !!opts.quiet});
    } catch (e) {
      session.syncStatus = 'error';
      hub.updateSyncPill();
      if (!opts.quiet) toast(e.message || 'Drive sync failed');
      throw e;
    } finally {
      syncInFlight = null;
      if (syncRequested) {
        syncRequested = false;
        const next = syncRequestOpts;
        syncRequestOpts = {};
        runSync(next).catch(() => {});
      }
    }
  })();
  return syncInFlight;
}

export function scheduleCsvSync() {
  clearTimeout(csvSyncT);
  csvSyncT = setTimeout(() => { runSync({quiet: true}).catch(() => {}); }, 500);
}

export async function syncCsvToDrive() {
  return runSync({quiet: false});
}

async function pullIfIdle() {
  if (!settings.driveToken || !session.loggedIn) return;
  if (uiBusy()) return;
  if (session.syncStatus === 'syncing') return;
  try { await runSync({quiet: true, light: true}); }
  catch (e) {}
}

export function startLiveSync() {
  if (startLiveSync._bound) return;
  startLiveSync._bound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullIfIdle();
  });
  window.addEventListener('focus', pullIfIdle);
  window.addEventListener('online', pullIfIdle);
  window.addEventListener('pageshow', pullIfIdle);
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    pullIfIdle();
  }, 12000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startLiveSync);
  else startLiveSync();
}

export function updateSyncPill() {
  const pill = $('sync-pill');
  const dot = $('sync-dot');
  const textEl = $('sync-text');
  const on = !!settings.driveToken && session.syncStatus !== 'error';
  if (dot) {
    dot.classList.toggle('on', on && session.syncStatus !== 'syncing');
    dot.classList.toggle('spin', session.syncStatus === 'syncing');
  }
  const email = settings.user && settings.user.email ? settings.user.email : '';
  let text = 'Saved to this device only — tap to continue with Google';
  if (session.syncStatus === 'syncing') text = 'Syncing with Google Drive…';
  else if (session.syncStatus === 'error') text = 'Drive sync failed — tap to retry';
  else if (!settings.driveToken) text = 'Saved to this device only — tap to continue with Google';
  else if (session.syncHint === 'merged') text = email ? 'Merged with Drive · ' + email : 'Merged with Drive';
  else if (session.syncHint === 'local') text = 'Saved to this device only';
  else text = email ? ('Drive · ' + email) : 'Synced with Google Drive';
  if (textEl) textEl.textContent = text;
  if (pill) {
    pill.classList.toggle('tappable', session.syncStatus !== 'syncing');
    pill.classList.toggle('warn', !settings.driveToken || session.syncStatus === 'error' || session.syncHint === 'local');
  }
}

hub.updateSyncPill = updateSyncPill;
hub.scheduleCsvSync = scheduleCsvSync;
hub.reconcileLedgerWithDrive = reconcileLedgerWithDrive;
hub.pullCsvFromDrive = pullCsvFromDrive;
