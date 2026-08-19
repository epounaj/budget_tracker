/** Shared photo album + lightbox. Thumbs stay small; lightbox always prefers a full image. */
import {settings, session, state} from './store.js?v=20260819b';
import {$, esc, compressImage, extFromFile} from './util.js?v=20260819b';
import {driveFetch} from './drive.js?v=20260819b';

export const THUMB_MAX = 720;
export const THUMB_Q = 0.82;
export const OCR_MAX = 2000;
export const OCR_Q = 0.85;

const drivePreviewCache = {};

const CAM_SVG = '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
const GAL_SVG = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const OCR_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/></svg>';

export function pendingPhotos() {
  const p = session.pending;
  return (p && Array.isArray(p.photos)) ? p.photos : [];
}

export function thumbSrc(photo) {
  if (!photo) return '';
  if (typeof photo === 'string') return photo;
  return photo.thumbDataUrl || photo.thumb || '';
}

export function ocrSrc(photo) {
  if (!photo) return '';
  return photo.ocrDataUrl || photo.previewUrl || photo.url || photo.thumbDataUrl || photo.thumb || '';
}

function isBlobOrData(u) {
  return typeof u === 'string' && (u.startsWith('blob:') || u.startsWith('data:image/'));
}

/** High-res only. Never returns the list thumb when a fuller source exists. */
export function pickFullSrc(photo) {
  if (!photo) return '';
  if (typeof photo === 'string') return photo;
  if (photo.previewUrl) return photo.previewUrl;
  if (photo.ocrDataUrl) return photo.ocrDataUrl;
  if (photo.originalFile) {
    try { return URL.createObjectURL(photo.originalFile); } catch (e) {}
  }
  const u = photo.url;
  if (u && isBlobOrData(u) && u !== photo.thumb && u !== photo.thumbDataUrl) return u;
  return '';
}

export function persistablePhoto(ph, link) {
  const out = {thumb: (ph && (ph.thumbDataUrl || ph.thumb)) || ''};
  const id = (link && link.id) || (ph && ph.driveFileId) || '';
  const view = (link && link.webViewLink) || (ph && ph.webViewLink) || '';
  if (id) out.driveFileId = id;
  if (view) out.webViewLink = view;
  return out;
}

export async function driveOriginalSrc(fileId) {
  if (!fileId || !settings.driveToken) return '';
  if (drivePreviewCache[fileId]) return drivePreviewCache[fileId];
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media');
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  drivePreviewCache[fileId] = url;
  return url;
}

export function hideLightbox() {
  const box = $('lightbox');
  if (box) box.classList.remove('show');
}

export function showLightbox(photoOrSrc, cap, driveLink) {
  const box = $('lightbox');
  if (!box) return;
  const img = $('lightbox-img');
  const bar = $('lightbox-bar');
  const open = $('lightbox-drive');
  const label = $('lightbox-cap');
  const photo = (photoOrSrc && typeof photoOrSrc === 'object') ? photoOrSrc : null;
  const fileId = (photo && photo.driveFileId) || '';
  const link = driveLink || (photo && photo.webViewLink) || '';
  const full = pickFullSrc(photoOrSrc);
  const thumb = thumbSrc(photo) || (!photo && typeof photoOrSrc === 'string' ? photoOrSrc : '');

  if (label) label.textContent = cap || '';
  if (open) {
    if (link) { open.href = link; open.style.display = ''; }
    else { open.removeAttribute('href'); open.style.display = 'none'; }
  }
  if (bar) bar.hidden = !(cap || link);
  box.classList.add('show');
  if (!img) return;

  const apply = src => {
    if (!src || !box.classList.contains('show')) return;
    img.src = src;
    img.style.display = '';
  };
  const fallbackThumb = () => {
    if (thumb && (!img.src || img.src !== thumb)) apply(thumb);
    else if (!thumb && !img.src) img.style.display = 'none';
  };

  img.onerror = null;
  img.removeAttribute('src');
  const onFail = () => {
    img.onerror = null;
    if (fileId && settings.driveToken) {
      driveOriginalSrc(fileId).then(apply).catch(fallbackThumb);
    } else fallbackThumb();
  };

  if (full) {
    img.onerror = onFail;
    apply(full);
  } else if (fileId && settings.driveToken) {
    img.style.display = 'none';
    driveOriginalSrc(fileId).then(url => {
      if (url) apply(url);
      else fallbackThumb();
    }).catch(fallbackThumb);
  } else fallbackThumb();
}

function photoFromEl(im) {
  const kind = im.dataset.preview;
  const idx = Number(im.dataset.idx || 0) || 0;
  if (kind === 'album') {
    const ph = pendingPhotos()[idx];
    if (ph) return {photo: ph, cap: 'Photo ' + (idx + 1), link: ph.webViewLink || ''};
    return {
      photo: {
        thumb: im.getAttribute('src') || '',
        driveFileId: im.dataset.driveId || '',
        webViewLink: im.dataset.driveLink || ''
      },
      cap: im.alt || 'Photo',
      link: im.dataset.driveLink || ''
    };
  }
  if (kind === 'purchase') {
    const r = (state.purchases || []).find(x => x.id === im.dataset.id);
    if (!r) return null;
    return {
      photo: {thumb: r.thumb, driveFileId: r.driveFileId, webViewLink: r.driveLink},
      cap: r.item || 'Receipt',
      link: r.driveLink || ''
    };
  }
  if (kind === 'seller') {
    const s = (state.sellers || []).find(x => x.id === im.dataset.id);
    if (!s || !Array.isArray(s.photos)) return null;
    const ph = s.photos[idx] || {};
    const ln = (Array.isArray(s.photoLinks) && s.photoLinks[idx]) || {};
    return {
      photo: {
        thumb: ph.thumb,
        url: ph.url,
        previewUrl: ph.previewUrl,
        ocrDataUrl: ph.ocrDataUrl,
        driveFileId: ph.driveFileId || ln.id || '',
        webViewLink: ph.webViewLink || ln.webViewLink || ''
      },
      cap: s.name || 'Seller photo',
      link: ph.webViewLink || ln.webViewLink || ''
    };
  }
  if (kind === 'catalog') {
    return {
      photo: {
        thumb: im.getAttribute('src') || '',
        driveFileId: im.dataset.driveId || '',
        webViewLink: im.dataset.driveLink || ''
      },
      cap: im.alt || 'Reference photo',
      link: im.dataset.driveLink || ''
    };
  }
  if (kind === 'labour') {
    const s = (state.labour || []).find(x => x.id === im.dataset.id);
    if (!s || !Array.isArray(s.photos)) {
      if (s && (s.thumb || s.driveFileId)) {
        return {
          photo: {thumb: s.thumb, driveFileId: s.driveFileId, webViewLink: s.driveLink},
          cap: s.payee || 'Labour proof',
          link: s.driveLink || ''
        };
      }
      return null;
    }
    const ph = s.photos[idx] || {};
    const ln = (Array.isArray(s.photoLinks) && s.photoLinks[idx]) || {};
    return {
      photo: {
        thumb: ph.thumb,
        url: ph.url,
        previewUrl: ph.previewUrl,
        ocrDataUrl: ph.ocrDataUrl,
        driveFileId: ph.driveFileId || ln.id || s.driveFileId || '',
        webViewLink: ph.webViewLink || ln.webViewLink || s.driveLink || ''
      },
      cap: s.payee || 'Labour proof',
      link: ph.webViewLink || ln.webViewLink || s.driveLink || ''
    };
  }
  return null;
}

export function bindPhotoPreview(root) {
  if (!root) return;
  if (root._photoPreviewBound) return;
  root._photoPreviewBound = true;
  root.addEventListener('click', e => {
    const im = e.target && e.target.closest && e.target.closest('[data-preview]');
    if (!im) return;
    e.preventDefault();
    e.stopPropagation();
    const found = photoFromEl(im);
    if (!found) return;
    showLightbox(found.photo, found.cap, found.link);
  });
}

export function bindLightboxShell() {
  const lbClose = $('lightbox-close');
  const lightbox = $('lightbox');
  if (lbClose) lbClose.onclick = hideLightbox;
  if (lightbox) lightbox.addEventListener('click', e => {
    if (e.target && e.target.id === 'lightbox') hideLightbox();
  });
}

export function clearPendingPhoto() {
  const p = session.pending;
  if (p && Array.isArray(p.photos)) {
    p.photos.forEach(ph => { if (ph && ph.previewUrl) try { URL.revokeObjectURL(ph.previewUrl); } catch (e) {} });
  } else if (p && p.previewUrl) {
    try { URL.revokeObjectURL(p.previewUrl); } catch (e) {}
  }
  session.pending = null;
}

export function renderAlbumPreview() {
  const list = $('m-photo-list'), pv = $('m-photo-preview'), meta = $('m-photo-meta');
  if (!list || !pv) return;
  const photos = pendingPhotos();
  if (!photos.length) return;
  list.innerHTML = albumListHtml(photos, {kind: 'album', alt: 'Photo'});
  pv.classList.add('show');
  if (meta) {
    const files = photos.filter(ph => ph && ph.originalFile);
    const kb = files.reduce((s, ph) => s + Math.max(1, Math.round((ph.originalFile.size || 0) / 1024)), 0);
    meta.textContent = files.length
      ? (files.length + ' photo' + (files.length === 1 ? '' : 's') + ' attached · ' + kb + ' KB total. Tap to view larger.')
      : 'Photo attached. Tap to view larger.';
  }
}

export async function handlePhoto(file, append) {
  if (!file) return;
  if (!append) clearPendingPhoto();
  session.photoCleared = false;
  const isPdf = (file.type && file.type === 'application/pdf') || /\.pdf$/i.test(file.name || '');
  let previewUrl = '';
  try { previewUrl = URL.createObjectURL(file); } catch (e) {}
  let thumbDataUrl = '', ocrDataUrl = '';
  const pdfThumb = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect fill="#D9F3E6" width="80" height="80" rx="12"/><text x="40" y="46" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#0B7A55">PDF</text></svg>');
  if (isPdf) {
    thumbDataUrl = pdfThumb;
  } else {
    try { thumbDataUrl = await compressImage(file, THUMB_MAX, THUMB_Q); } catch (e) {}
    try { ocrDataUrl = await compressImage(file, OCR_MAX, OCR_Q); } catch (e) {}
  }
  const nextPhoto = {
    originalFile: file,
    previewUrl,
    thumbDataUrl: thumbDataUrl || previewUrl,
    thumb: thumbDataUrl || previewUrl,
    ocrDataUrl: ocrDataUrl || previewUrl || thumbDataUrl,
    ext: isPdf ? 'pdf' : extFromFile(file)
  };
  if (!session.pending || !Array.isArray(session.pending.photos)) session.pending = {photos: []};
  session.pending.photos.push(nextPhoto);
  renderAlbumPreview();
}

export function removePendingPhoto() {
  clearPendingPhoto();
  session.photoCleared = true;
  const pv = $('m-photo-preview');
  if (pv) pv.classList.remove('show');
  const list = $('m-photo-list');
  if (list) list.innerHTML = '';
  ['m-photo', 'm-photo-cam'].forEach(id => { const el = $(id); if (el) el.value = ''; });
}

export function albumListHtml(photos, opts) {
  opts = opts || {};
  const pending = pendingPhotos();
  return (photos || []).map((ph, i) => {
    const thumb = thumbSrc(ph);
    if (!thumb) return '';
    let attrs = ' data-preview="album" data-idx="' + i + '"';
    if (!pending.length && opts.kind === 'purchase' && opts.recordId) {
      attrs = ' data-preview="purchase" data-id="' + esc(opts.recordId) + '"';
    } else if (!pending.length && opts.kind === 'labour' && opts.recordId) {
      attrs = ' data-preview="labour" data-id="' + esc(opts.recordId) + '" data-idx="' + i + '"';
    }
    if (ph.driveFileId) attrs += ' data-drive-id="' + esc(ph.driveFileId) + '"';
    if (ph.webViewLink) attrs += ' data-drive-link="' + esc(ph.webViewLink) + '"';
    return '<img src="' + esc(thumb) + '"' + attrs + ' alt="' + esc(opts.alt || 'Photo') + ' ' + (i + 1) + '">';
  }).join('');
}

export function existingFormPhotos(rec, kind) {
  const pending = pendingPhotos();
  if (pending.length) return pending;
  if (session.photoCleared || !rec) return [];
  if (kind === 'sellers' || kind === 'labour') {
    const links = Array.isArray(rec.photoLinks) ? rec.photoLinks : [];
    const photos = Array.isArray(rec.photos) ? rec.photos : [];
    if (photos.length) {
      return photos.map((ph, i) => Object.assign({}, ph, {
        driveFileId: ph.driveFileId || (links[i] && links[i].id) || rec.driveFileId || '',
        webViewLink: ph.webViewLink || (links[i] && links[i].webViewLink) || rec.driveLink || ''
      }));
    }
  }
  if (rec.thumb || rec.driveFileId) {
    return [{
      thumb: rec.thumb || '',
      thumbDataUrl: rec.thumb || '',
      driveFileId: rec.driveFileId || '',
      webViewLink: rec.driveLink || ''
    }];
  }
  return [];
}

export function photoFieldHtml(opts) {
  opts = opts || {};
  const photos = opts.photos || [];
  const has = photos.length > 0;
  const skipOcr = !!opts.skipOcr;
  const accept = opts.accept || 'image/*';
  const ocrLabel = opts.ocrLabel || (opts.hasKey ? 'Re-scan with AI' : 'Extract with AI');
  const hint = opts.hint || 'For multi-page receipts, add all photos first. AI reads every page into one table.';
  return '<div class="photo-field" style="margin-bottom:14px">' +
    '<div class="photo-actions">' +
    '<label class="photo-btn">' + CAM_SVG + 'Camera' +
    '<input type="file" accept="image/*" capture="environment" id="m-photo-cam" style="display:none"></label>' +
    '<label class="photo-btn">' + GAL_SVG + 'Gallery' +
    '<input type="file" accept="' + accept + '" multiple id="m-photo" style="display:none"></label></div>' +
    '<p class="field-hint">' + hint + '</p>' +
    (opts.extraHtml || '') +
    (skipOcr ? '' : ('<button type="button" class="ocr-btn" id="m-ocr" style="margin-top:10px">' + OCR_SVG + ocrLabel + '</button>' +
    '<div class="ocr-status" id="m-ocr-status"></div>')) +
    '<div class="photo-preview' + (has ? ' show' : '') + '" id="m-photo-preview">' +
    '<div class="photo-list" id="m-photo-list">' + albumListHtml(photos, opts) + '</div>' +
    '<div class="photo-preview-meta"><p class="field-hint" id="m-photo-meta">' +
    (has ? (photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' attached. Tap to view larger.') : '') +
    '</p><button type="button" class="photo-remove" id="m-photo-remove">Remove photos</button></div></div></div>';
}

export function bindAlbumControls(root, afterAdd) {
  const onFile = async e => {
    const fs = [...(e.target.files || [])];
    if (!fs.length) return;
    for (const f of fs) await handlePhoto(f, true);
    if (typeof afterAdd === 'function') await afterAdd();
    try { e.target.value = ''; } catch (err) {}
  };
  const pin = $('m-photo'); if (pin) pin.addEventListener('change', onFile);
  const cam = $('m-photo-cam'); if (cam) cam.addEventListener('change', onFile);
  const prm = $('m-photo-remove'); if (prm) prm.onclick = removePendingPhoto;
  if (!root || (!pin && !cam)) return;
  root.onpaste = async e => {
    if (session.editKind !== 'purchases' && session.editKind !== 'sellers' && session.editKind !== 'labour') return;
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const files = items.filter(it => it.type && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await handlePhoto(f, true);
    if (typeof afterAdd === 'function') await afterAdd();
  };
}
