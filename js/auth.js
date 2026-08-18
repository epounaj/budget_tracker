import {LOGIN_SCOPE, G_ICON} from './config.js';
import {settings, session, saveSettings, persist, stashAi, applyStashedAi, emptyLedger} from './store.js';
import {$, esc, toast} from './util.js';
import {hub} from './hub.js';
import {appClientId, ensureDriveFolder, loadProfileFromDrive, saveProfileToDrive, pullCsvFromDriveIfEmpty, scheduleCsvSync} from './drive.js';

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
  if (b && !silent) { b.disabled = true; b.innerHTML = G_ICON + 'Signing in…'; }
  const gTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid, scope: LOGIN_SCOPE,
    callback: async resp => {
      if (!resp || !resp.access_token) {
        if (!silent) { renderLogin(); loginErr(resp && resp.error_description || 'Sign-in cancelled.'); }
        return;
      }
      try { settings.driveClientId = cid; await completeLogin(resp.access_token, silent); }
      catch (e) {
        if (!silent) { renderLogin(); loginErr(e.message || 'Sign-in failed.'); }
        else toast(e.message || 'Could not refresh Google session');
      }
    },
    error_callback: err => {
      if (silent) return;
      renderLogin();
      loginErr((err && (err.message || err.type)) || 'Popup blocked. Allow popups for this site and try again.');
    }
  });
  gTokenClient.requestAccessToken({prompt: silent ? '' : 'select_account'});
}
async function completeLogin(token, quiet) {
  settings.driveToken = token;
  const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {headers: {Authorization: 'Bearer ' + token}});
  if (!ur.ok) throw new Error('Could not read Google profile');
  const u = await ur.json();
  if (settings.userSub && settings.userSub !== u.sub) {
    stashAi(settings.userSub);
    emptyLedger();
    for (const s of ['funds', 'budget', 'actions', 'sellers', 'purchases']) await persist(s);
  }
  applyStashedAi(u.sub);
  settings.user = {email: u.email, name: u.name, picture: u.picture};
  settings.userSub = u.sub;
  settings.autoCsv = true;
  await saveSettings();
  hideLogin();
  hub.updateUserChip();
  hub.render();
  try {
    const existed = !!settings.driveFolderId;
    await ensureDriveFolder();
    await loadProfileFromDrive();
    await saveProfileToDrive();
    await pullCsvFromDriveIfEmpty();
    await saveSettings();
    hub.updateUserChip();
    hub.render();
    scheduleCsvSync();
    if (!quiet && !existed) toast('Drive folder: My Drive → Site Ledger');
  } catch (e) { if (!quiet) toast(e.message || 'Signed in, but Drive sync is not ready yet'); }
}
export async function googleLogout() {
  const tok = settings.driveToken;
  if (tok && window.google && google.accounts && google.accounts.oauth2) try { google.accounts.oauth2.revoke(tok, () => {}); } catch (e) {}
  stashAi(settings.userSub);
  settings.apiKey = ''; settings.model = ''; settings.apiBase = ''; settings.models = [];
  settings.driveToken = null; settings.user = null; settings.userSub = '';
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
