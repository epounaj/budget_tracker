/**
 * Site Ledger — module map (change one area without rewriting the app):
 *   config.js    constants (categories, OAuth client, file names)
 *   store.js     IndexedDB, ledger state, per-user AI profile
 *   ai.js        OpenAI-compatible providers, OCR, model picker
 *   drive.js     Drive folders, original photo upload, CSV/profile sync
 *   receipts.js  camera/gallery, keep original, AI fill, user corrections
 *   auth.js      Google sign-in
 *   ui.js        lists, sticky Save modal, settings
 *   csv.js       export/import
 */
import {GOOGLE_CLIENT_ID, APP_VERSION} from './config.js?v=20260818q';
import {loadAll, settings, session, restoreSavedToken} from './store.js?v=20260818q';
import {renderLogin, loadGis, resumeSession} from './auth.js?v=20260818q';
import {bindShell} from './ui.js?v=20260818q';
import {initChat} from './chat.js?v=20260818q';
import {appClientId} from './drive.js?v=20260818q';

bindShell();
initChat();
const _bt = document.getElementById('build-tag');
if (_bt) _bt.textContent = APP_VERSION;

(async function init() {
  renderLogin();
  try {
    await loadAll();
    session.activeTab = localStorage.getItem('sl.tab') || 'dashboard';
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === session.activeTab));
    restoreSavedToken();
    session.lastClientId = GOOGLE_CLIENT_ID || settings.driveClientId || '';
    await loadGis();
    if (settings.user && appClientId()) {
      await resumeSession();
      return;
    }
  } catch (e) { console.error(e); }
  renderLogin();
})();
