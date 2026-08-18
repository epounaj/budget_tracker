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
import {GOOGLE_CLIENT_ID} from './config.js';
import {loadAll, settings, session} from './store.js';
import {renderLogin, loadGis, startGoogleLogin, hideLogin, updateUserChip} from './auth.js';
import {render, bindShell} from './ui.js';
import {appClientId} from './drive.js';

bindShell();

(async function init() {
  renderLogin();
  try {
    await loadAll();
    session.lastClientId = GOOGLE_CLIENT_ID || settings.driveClientId || '';
    await loadGis();
    if (settings.user && appClientId()) {
      hideLogin();
      updateUserChip();
      render();
      startGoogleLogin(true);
      return;
    }
  } catch (e) { console.error(e); }
  renderLogin();
})();
