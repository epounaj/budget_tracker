import {LOGIN_SCOPE, G_ICON} from './config.js?v=20260818i';
import {settings, session, saveSettings, persist, stashAi, applyStashedAi, emptyLedger, persistOauth, clearSavedToken, tokenIsFresh} from './store.js?v=20260818i';
import {$, esc, toast} from './util.js?v=20260818i';
import {hub} from './hub.js?v=20260818i';
import {appClientId, ensureDriveFolder, loadProfileFromDrive, saveProfileToDrive, reconcileLedgerWithDrive} from './drive.js?v=20260818i';

export function secureContext() { return window.isSecureContext === true && location.protocol !== 'file:'; }
export function loadGis() {
  return new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load Google script'));
    document.head.appendChild(s);
  });
}
export function showLogin(opts) {
  opts = opts || {};
  $('login-screen').classList.add('show');
  $('app').hidden = true;
  session.loggedIn = false;
  renderLogin(opts);
}
export function hideLogin() {
  $('login-screen').classList.remove('show');
  $('app').hidden = false;
  session.loggedIn = true;
}
function loginErr(msg) {
  const e = $('login-error');
  if (!e) return;
  e.textContent = msg;
  e.classList.add('show');
}
export function renderLogin(opts) {
  opts = opts || {};
  const insecure = !secureContext();
  const origin = location.origin;
  const cid = appClientId() || session.lastClientId;
  const who = settings.user && (settings.user.name || settings.user.email);
  $('login-card').innerHTML =
    '<div class="login-brand"><div class="logo"><svg viewBox="0 0 24 24"><path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6"/></svg></div><h1>Site Ledger</h1></div>' +
    '<h2>Sign in to continue</h2>' +
    '<p class="lead">' + (who ? 'Welcome back, ' + esc(who) + '. ' : '') + 'Sign in with Google. Your ledger and API keys stay in <b>your</b> Drive, not on this website.</p>' +
    (insecure ? '<div class="set-note">This file was opened as <b>file://</b>. Open <b>http://127.0.0.1:8765</b> instead.</div>' :
      ((cid ? '' : '<div class="field" style="margin-bottom:12px"><label>App OAuth Client ID (one-time setup)</label><input id="login-client-id" value="" placeholder="….apps.googleusercontent.com" autocomplete="off"></div>' +
        '<div class="set-note" style="margin-bottom:12px">Authorised origin must be <b>' + esc(origin) + '</b>. After this is saved, other people only click Google — they never paste this ID.</div>') +
       '<button class="google-btn" id="google-login"' + (opts.busy ? ' disabled' : '') + '>' + G_ICON + (opts.busy ? 'Signing in…' : 'Continue with Google') + '</button>' +
       '<div class="set-note">Keep this tab open. Allow popups so Google opens in a small window.</div>')) +
    '<p class="error-text" id="login-error"></p>';
  const btn = $('google-login');
  if (btn) btn.onclick = () => startGoogleLogin(false);
}
function loginScreenOpen() {
  const el = $('login-screen');
  return !!(el && el.classList.contains('show'));
}
function failAuth(err, silent) {
  if (loginScreenOpen() && !session.loggedIn) {
    renderLogin();
    if (!silent) loginErr((err && (err.message || err.type || err.error_description)) || 'Sign-in cancelled.');
    return;
  }
  hub.updateSyncPill();
}
export function startGoogleLogin(silent) {
  if (!secureContext()) return loginErr('Needs https or localhost.');
  const cid = appClientId() || session.lastClientId;
  if (!cid) return loginErr('Paste the app Client ID once (from Google Cloud). Users after that only sign in with Google.');
  session.lastClientId = cid;
  if (!(window.google && google.accounts && google.accounts.oauth2)) {
    if (silent) return;
    return loginErr('Google script still loading — wait a second and tap again.');
  }
  const b = $('google-login');
  if (b && !silent && loginScreenOpen()) { b.disabled = true; b.innerHTML = G_ICON + 'Signing in…'; }
  const gTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid, scope: LOGIN_SCOPE,
    callback: async resp => {
      if (!resp || !resp.access_token) {
        failAuth(resp, silent);
        return;
      }
      try { settings.driveClientId = cid; await completeLogin(resp.access_token, silent, resp.expires_in); }
      catch (e) { failAuth(e, silent); }
    },
    error_callback: err => failAuth(err, silent)
  });
  gTokenClient.requestAccessToken({prompt: silent ? 'none' : (session.loggedIn ? '' : 'select_account')});
}
export async function resumeSession() {
  if (!settings.user || !appClientId()) return false;
  hideLogin();
  hub.updateUserChip();
  hub.render();
  if (tokenIsFresh()) {
    try {
      await completeLogin(settings.driveToken, true, Math.max(60, Math.floor((settings.driveTokenExp - Date.now()) / 1000)));
      return true;
    } catch (e) {
      clearSavedToken();
    }
  }
  startGoogleLogin(true);
  return true;
}
async function completeLogin(token, quiet, expiresIn) {
  persistOauth(token, expiresIn, settings.userSub);
  const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {headers: {Authorization: 'Bearer ' + token}});
  if (!ur.ok) {
    clearSavedToken();
    throw new Error('Could not read Google profile');
  }
  const u = await ur.json();
  if (settings.userSub && settings.userSub !== u.sub) {
    stashAi(settings.userSub);
    emptyLedger();
    settings.csvSyncedAt = '';
    settings.csvDirty = false;
    for (const s of ['funds', 'budget', 'actions', 'sellers', 'purchases']) await persist(s, {fromSync: true});
  }
  applyStashedAi(u.sub);
  settings.user = {email: u.email, name: u.name, picture: u.picture};
  settings.userSub = u.sub;
  settings.autoCsv = true;
  persistOauth(token, expiresIn, u.sub);
  await saveSettings();
  hideLogin();
  hub.updateUserChip();
  hub.render();
  try {
    const existed = !!settings.driveFolderId;
    await ensureDriveFolder();
    await loadProfileFromDrive();
    await saveProfileToDrive();
    await reconcileLedgerWithDrive({quiet: true});
    await saveSettings();
    hub.updateUserChip();
    hub.render();
    if (!quiet && !existed) toast('Drive folder: My Drive → Site Ledger');
  } catch (e) { toast(e.message || 'Signed in, but Drive sync is not ready yet'); }
}
export async function googleLogout() {
  const tok = settings.driveToken;
  if (tok && window.google && google.accounts && google.accounts.oauth2) try { google.accounts.oauth2.revoke(tok, () => {}); } catch (e) {}
  stashAi(settings.userSub);
  settings.apiKey = ''; settings.model = ''; settings.apiBase = ''; settings.models = [];
  settings.user = null; settings.userSub = '';
  clearSavedToken();
  await saveSettings();
  hub.updateUserChip();
  showLogin();
  toast('Signed out');
}
export function updateUserChip() {
  const chip = $('user-chip');
  if (!chip) return;
  if (!settings.user) { chip.classList.remove('show'); return; }
  $('user-pic').src = settings.user.picture || '';
  $('user-name').textContent = settings.user.name || settings.user.email || 'Signed in';
  chip.classList.add('show');
}

hub.showLogin = showLogin;
hub.hideLogin = hideLogin;
hub.renderLogin = renderLogin;
hub.updateUserChip = updateUserChip;
