import {GOOGLE_CLIENT_ID, PROFILE_FILE, CSV_FILE} from './config.js?v=20260818b';
import {settings, state, saveSettings, applyAi, persist, snapshotAi, replaceLedger, session, ledgerEmpty, clearSavedToken} from './store.js?v=20260818b';
import {$, toast, todayStr, folderSafe, driveQueryName, normalizeCategory, dataURLtoBlob, extFromFile, compressImage} from './util.js?v=20260818b';
import {toCSV, fromCSV} from './csv.js?v=20260818b';
import {hub} from './hub.js?v=20260818b';

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
  const r = await fetch(url, opts);
  if (r.status === 401) { clearSavedToken(); throw new Error('Drive session expired — sign in again'); }
  if (!r.ok) {
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
  return r;
}

export async function ensureDriveFolder() {
  if (!settings.driveToken) throw new Error('Sign in first');
  if (settings.driveFolderId) {
    try {
      const chk = await driveFetch('https://www.googleapis.com/drive/v3/files/' + settings.driveFolderId + '?fields=id,name,trashed');
      const info = await chk.json();
      if (info.id && !info.trashed) return settings.driveFolderId;
    } catch (e) { settings.driveFolderId = ''; }
  }
  const q = encodeURIComponent("name='Site Ledger' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,createdTime)&spaces=drive&orderBy=createdTime');
  const j = await r.json();
  const folders = j.files || [];
  if (folders.length) {
    let chosen = folders[0];
    for (const f of folders) {
      if (await findDriveChild(f.id, CSV_FILE, false)) { chosen = f; break; }
    }
    settings.driveFolderId = chosen.id;
  } else {
    const cr = await driveFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'Site Ledger', mimeType: 'application/vnd.google-apps.folder', parents: ['root']})
    });
    const cj = await cr.json();
    if (!cj.id) throw new Error('Google did not create the Site Ledger folder');
    settings.driveFolderId = cj.id;
  }
  await saveSettings();
  return settings.driveFolderId;
}

async function findDriveChild(parentId, name, folderOnly) {
  const extra = folderOnly ? " and mimeType='application/vnd.google-apps.folder'" : '';
  const q = encodeURIComponent("name='" + driveQueryName(name) + "' and '" + parentId + "' in parents and trashed=false" + extra);
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&spaces=drive');
  const j = await r.json();
  return (j.files && j.files[0] && j.files[0].id) || null;
}
async function ensureChildFolder(parentId, name) {
  name = folderSafe(name) || 'Other';
  const id = await findDriveChild(parentId, name, true);
  if (id) return id;
  const cr = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId]})
  });
  const cj = await cr.json();
  if (!cj.id) throw new Error('Could not create Drive folder ' + name);
  return cj.id;
}
export async function findDriveFile(name) {
  await ensureDriveFolder();
  return findDriveChild(settings.driveFolderId, name, false);
}
export async function findDriveFileMeta(name) {
  await ensureDriveFolder();
  const q = encodeURIComponent("name='" + driveQueryName(name) + "' and '" + settings.driveFolderId + "' in parents and trashed=false");
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,modifiedTime)&spaces=drive');
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

async function applyDriveCsv(meta) {
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files/' + meta.id + '?alt=media');
  if (!r.ok) throw new Error('Could not read ledger from Drive');
  replaceLedger(fromCSV(await r.text()));
  for (const s of ['funds', 'budget', 'actions', 'sellers', 'purchases']) await persist(s, {fromSync: true});
  settings.csvDirty = false;
  settings.csvSyncedAt = meta.modifiedTime || new Date().toISOString();
  await saveSettings();
  hub.render();
  hydratePurchaseThumbs();
}

async function pushCsvToDrive(quiet) {
  const out = await upsertDriveFile(CSV_FILE, new Blob([toCSV()], {type: 'text/csv'}));
  settings.csvDirty = false;
  settings.csvSyncedAt = (out && out.modifiedTime) || new Date().toISOString();
  await saveSettings();
  if (!quiet) toast('Synced to Drive');
}

/** Drive CSV is the shared ledger. Pull if Drive is newer or this browser never synced. */
export async function reconcileLedgerWithDrive(opts) {
  opts = opts || {};
  if (!settings.driveToken) return 'offline';
  session.syncStatus = 'syncing';
  hub.updateSyncPill();
  try {
    await ensureDriveFolder();
    const meta = await findDriveFileMeta(CSV_FILE);
    const empty = ledgerEmpty();
    if (opts.forcePull && meta) {
      await applyDriveCsv(meta);
      session.syncStatus = 'idle';
      hub.updateSyncPill();
      toast('Loaded ledger from Google Drive');
      return 'pulled';
    }
    if (!meta) {
      if (!empty) await pushCsvToDrive(true);
      session.syncStatus = 'idle';
      hub.updateSyncPill();
      return empty ? 'empty' : 'pushed';
    }
    const driveMs = Date.parse(meta.modifiedTime) || 0;
    const lastMs = Date.parse(settings.csvSyncedAt) || 0;
    if (empty || !lastMs || driveMs > lastMs + 2000) {
      await applyDriveCsv(meta);
      session.syncStatus = 'idle';
      hub.updateSyncPill();
      if (!opts.quiet) toast('Loaded ledger from Google Drive');
      return 'pulled';
    }
    if (settings.csvDirty) {
      await pushCsvToDrive(true);
      session.syncStatus = 'idle';
      hub.updateSyncPill();
      return 'pushed';
    }
    session.syncStatus = 'idle';
    hub.updateSyncPill();
    return 'ok';
  } catch (e) {
    session.syncStatus = 'error';
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
      p.thumb = await compressImage(file, 360, 0.55);
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
  const catName = folderSafe(normalizeCategory(info.category) || info.category) || 'Uncategorized';
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

let csvSyncT;
export function scheduleCsvSync() {
  clearTimeout(csvSyncT);
  csvSyncT = setTimeout(() => { syncCsvToDrive().catch(() => {}); }, 1500);
}
export async function syncCsvToDrive() {
  if (!settings.driveToken) return;
  session.syncStatus = 'syncing';
  hub.updateSyncPill();
  try {
    await pushCsvToDrive(false);
    session.syncStatus = 'idle';
    hub.updateSyncPill();
  } catch (e) {
    session.syncStatus = 'error';
    hub.updateSyncPill();
    toast(e.message || 'Drive sync failed');
  }
}

export function updateSyncPill() {
  const pill = $('sync-pill');
  const on = !!settings.driveToken && session.syncStatus !== 'error';
  $('sync-dot').classList.toggle('on', on && session.syncStatus !== 'syncing');
  $('sync-dot').classList.toggle('spin', session.syncStatus === 'syncing');
  let text = 'Sign in required — tap to continue with Google';
  if (session.syncStatus === 'syncing') text = 'Syncing with Google Drive…';
  else if (session.syncStatus === 'error') text = 'Drive sync failed — tap to retry';
  else if (settings.driveToken) text = settings.user && settings.user.email ? 'Drive · ' + settings.user.email : 'Synced to Google Drive';
  $('sync-text').textContent = text;
  if (pill) pill.classList.toggle('tappable', !settings.driveToken || session.syncStatus === 'error');
}

hub.updateSyncPill = updateSyncPill;
hub.scheduleCsvSync = scheduleCsvSync;
hub.reconcileLedgerWithDrive = reconcileLedgerWithDrive;
hub.pullCsvFromDrive = pullCsvFromDrive;
